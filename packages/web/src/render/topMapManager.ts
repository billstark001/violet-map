import * as THREE from 'three';
import {
  buildTopMapMesh,
  prepareTopMapTile,
  topMapCoverageChunkCount,
  topMapCoverageKeyFromMask,
  TOP_MAP_MISSING_HEIGHT,
  TOP_MAP_TILE_BLOCKS,
  type MeshBuffers,
  type PreparedTopMapTile,
  type TopMapTilePayload,
} from '@violet-map/core';
import {
  fetchTopMapManifest,
  fetchTopMapTile,
} from '../api';
import { debugLog } from '../logger';
import { createTopMapMaterial, type SharedUniforms } from './materials';

const MAX_RESIDENT_TILES = 96;
const MAX_WANTED_TILES = 96;
const MAX_PENDING_TILES = 6;
const LOD4_ZOOM_THRESHOLD = 1.15;
const LOD2_ZOOM_THRESHOLD = 2.25;
const FREE_VIEW_LOD2_DISTANCE_BLOCKS = 32 * 16;
const FREE_VIEW_LOD4_DISTANCE_BLOCKS = 128 * 16;
const FAILED_TILE_RETRY_MS = 12000;
const UPDATE_INTERVAL_MS = 100;
const FULL_COVERAGE_KEY = '*';
const TILE_HALF_DIAGONAL_BLOCKS = TOP_MAP_TILE_BLOCKS * Math.SQRT2 / 2;
const TOP_MAP_CHUNKS_PER_AXIS = TOP_MAP_TILE_BLOCKS / 16;
const TOP_MAP_CHUNK_MASK_BYTES = TOP_MAP_CHUNKS_PER_AXIS * TOP_MAP_CHUNKS_PER_AXIS / 8;

function residentTileBudget(): number {
  const memory = typeof navigator !== 'undefined'
    ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory
    : undefined;
  if (memory !== undefined && memory <= 4) return Math.min(MAX_RESIDENT_TILES, 48);
  if (memory !== undefined && memory <= 8) return Math.min(MAX_RESIDENT_TILES, 72);
  return MAX_RESIDENT_TILES;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export interface TopMapUpdateOptions {
  mode: 'perspective' | 'top';
  radiusBlocks?: number;
  /** Hard radial cutoff around the active camera. */
  maxDistanceBlocks?: number;
  onlineChunks?: ReadonlySet<string>;
}

export interface TopMapDiagnosticSnapshot {
  world: string;
  dimension: string;
  enabled: boolean;
  manifestLoaded: boolean;
  availableTiles: number;
  pendingTiles: string[];
  wantedTiles: string[];
  residentTiles: {
    key: string;
    step: number;
    coverageKey: string;
    visible: boolean;
    meshBytes: number;
    lastUsed: number;
  }[];
}

interface TopMapData {
  payload: TopMapTilePayload;
  prepared: PreparedTopMapTile;
  texture: THREE.DataTexture;
}

interface TopMapTile {
  key: string;
  data: TopMapData;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null;
  material: THREE.ShaderMaterial;
  step: number;
  coverageKey: string;
  lastUsed: number;
}

function createColorTexture(data: PreparedTopMapTile): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    data.colors,
    data.payload.size.colorSamples,
    data.payload.size.colorSamples,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function prepareTopMap(payload: TopMapTilePayload): TopMapData {
  const prepared = prepareTopMapTile(payload);
  return {
    payload,
    prepared,
    texture: createColorTexture(prepared),
  };
}

function geometryBytes(b: MeshBuffers): number {
  return b.positions.byteLength + (b.uvs?.byteLength ?? 0) + (b.atlasRects?.byteLength ?? 0)
    + b.colors.byteLength + b.lights.byteLength + b.indices.byteLength;
}

function buildGeometry(b: MeshBuffers): { geometry: THREE.BufferGeometry; bytes: number } {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(b.positions, 3, true));
  if (b.uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(b.uvs, 2, true));
  geometry.setAttribute('tintColor', new THREE.BufferAttribute(b.colors, 3, true));
  geometry.setAttribute('lightData', new THREE.BufferAttribute(b.lights, 2, true));
  geometry.setIndex(new THREE.BufferAttribute(b.indices, 1));
  if (b.bounds) {
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(b.bounds.min[0], b.bounds.min[1], b.bounds.min[2]),
      new THREE.Vector3(b.bounds.max[0], b.bounds.max[1], b.bounds.max[2]),
    );
    const center = new THREE.Vector3();
    geometry.boundingBox.getCenter(center);
    const radius = center.distanceTo(new THREE.Vector3(b.bounds.max[0], b.bounds.max[1], b.bounds.max[2]));
    geometry.boundingSphere = new THREE.Sphere(center, radius);
  } else {
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }
  return { geometry, bytes: geometryBytes(b) };
}

function buildTileGeometry(
  data: TopMapData,
  step: number,
  onlineChunkMask: Uint8Array | undefined,
): { geometry: THREE.BufferGeometry; bytes: number } | null {
  const buffers = buildTopMapMesh(data.prepared, { step, onlineChunkMask });
  if (!buffers || buffers.positions.length === 0 || buffers.indices.length === 0) return null;
  return buildGeometry(buffers);
}

interface TileCoverage {
  key: string;
  mask: Uint8Array;
}

function buildTileCoverage(onlineChunks: ReadonlySet<string> | undefined): Map<string, TileCoverage> {
  const masks = new Map<string, Uint8Array>();
  if (!onlineChunks?.size) return new Map();
  for (const chunkKey of onlineChunks) {
    const separator = chunkKey.indexOf(',');
    if (separator < 1) continue;
    const cx = Number(chunkKey.slice(0, separator));
    const cz = Number(chunkKey.slice(separator + 1));
    if (!Number.isInteger(cx) || !Number.isInteger(cz)) continue;
    const rx = Math.floor(cx / TOP_MAP_CHUNKS_PER_AXIS);
    const rz = Math.floor(cz / TOP_MAP_CHUNKS_PER_AXIS);
    const tileKey = `${rx},${rz}`;
    let mask = masks.get(tileKey);
    if (!mask) {
      mask = new Uint8Array(TOP_MAP_CHUNK_MASK_BYTES);
      masks.set(tileKey, mask);
    }
    const localX = cx - rx * TOP_MAP_CHUNKS_PER_AXIS;
    const localZ = cz - rz * TOP_MAP_CHUNKS_PER_AXIS;
    const index = localZ * TOP_MAP_CHUNKS_PER_AXIS + localX;
    mask[index >> 3] |= 1 << (index & 7);
  }
  const coverage = new Map<string, TileCoverage>();
  for (const [key, mask] of masks) coverage.set(key, { key: topMapCoverageKeyFromMask(mask), mask });
  return coverage;
}

export class TopMapManager {
  private readonly group = new THREE.Group();
  private readonly tiles = new Map<string, TopMapTile>();
  private readonly pendingTiles = new Set<string>();
  private readonly tileAborts = new Map<string, AbortController>();
  private world = '';
  private dimension = '';
  private topMapEnabled = false;
  private manifestLoaded = false;
  private manifestSeq = 0;
  private regionKeys = new Set<string>();
  private failedTiles = new Map<string, number>();
  private wantedTiles = new Set<string>();
  private latestMode: TopMapUpdateOptions['mode'] = 'top';
  private latestCameraX = 0;
  private latestCameraZ = 0;
  private latestZoom = 1;
  private latestCoverage = new Map<string, TileCoverage>();
  private coverageSource: ReadonlySet<string> | undefined;
  private lastUpdateAt = -Infinity;
  private disposed = false;
  private readonly residentLimit = residentTileBudget();
  private manifestAbort: AbortController | null = null;

  constructor(private readonly scene: THREE.Scene, private readonly shared: SharedUniforms) {
    this.group.visible = false;
    scene.add(this.group);
  }

  configure(world: string, dimension: string, topMapEnabled: boolean) {
    if (this.disposed) return;
    if (
      this.world === world
      && this.dimension === dimension
      && this.topMapEnabled === topMapEnabled
    ) return;
    this.world = world;
    this.dimension = dimension;
    this.topMapEnabled = topMapEnabled;
    this.manifestLoaded = !topMapEnabled;
    this.manifestSeq++;
    this.abortPendingLoads();
    this.regionKeys.clear();
    this.group.visible = topMapEnabled;
    this.pendingTiles.clear();
    this.failedTiles.clear();
    this.wantedTiles.clear();
    this.latestCoverage.clear();
    this.coverageSource = undefined;
    this.lastUpdateAt = -Infinity;
    this.clearTiles();
    debugLog('top-map', 'configure', { world, dimension, topMapEnabled });
    if (topMapEnabled) void this.loadManifest(world, dimension, this.manifestSeq);
  }

  update(camera: THREE.Camera, now: number, options: TopMapUpdateOptions) {
    const topMapAllowed = this.topMapEnabled
      && (!this.manifestLoaded || this.regionKeys.size > 0);
    if (!topMapAllowed || !this.world) {
      this.group.visible = false;
      return;
    }
    if (!this.manifestLoaded) {
      this.group.visible = false;
      return;
    }
    if (now - this.lastUpdateAt < UPDATE_INTERVAL_MS) return;
    this.lastUpdateAt = now;

    const view = this.viewMetrics(camera, options);
    this.latestMode = options.mode;
    this.latestCameraX = camera.position.x;
    this.latestCameraZ = camera.position.z;
    this.latestZoom = view.zoom;
    if (this.coverageSource !== options.onlineChunks) {
      this.coverageSource = options.onlineChunks;
      this.latestCoverage = buildTileCoverage(options.onlineChunks);
    }
    this.group.visible = true;
    const radiusX = view.width / 2 + TOP_MAP_TILE_BLOCKS;
    const radiusZ = view.height / 2 + TOP_MAP_TILE_BLOCKS;
    const minRx = Math.floor((camera.position.x - radiusX) / TOP_MAP_TILE_BLOCKS);
    const maxRx = Math.floor((camera.position.x + radiusX) / TOP_MAP_TILE_BLOCKS);
    const minRz = Math.floor((camera.position.z - radiusZ) / TOP_MAP_TILE_BLOCKS);
    const maxRz = Math.floor((camera.position.z + radiusZ) / TOP_MAP_TILE_BLOCKS);
    const candidates: { rx: number; rz: number; key: string; distance: number }[] = [];
    const maxDistance = typeof options.maxDistanceBlocks === 'number' && Number.isFinite(options.maxDistanceBlocks)
      ? Math.max(0, options.maxDistanceBlocks)
      : Infinity;

    for (let rz = minRz; rz <= maxRz; rz++) {
      for (let rx = minRx; rx <= maxRx; rx++) {
        const key = `${rx},${rz}`;
        if (!this.regionKeys.has(key)) continue;
        const centerX = rx * TOP_MAP_TILE_BLOCKS + TOP_MAP_TILE_BLOCKS / 2;
        const centerZ = rz * TOP_MAP_TILE_BLOCKS + TOP_MAP_TILE_BLOCKS / 2;
        const distance = Math.hypot(centerX - camera.position.x, centerZ - camera.position.z);
        // Keep the complete tile inside the cutoff. This avoids a coarse tile
        // leaking geometry beyond the requested chunk-distance clamp.
        if (distance + TILE_HALF_DIAGONAL_BLOCKS > maxDistance) continue;
        candidates.push({
          rx,
          rz,
          key,
          distance,
        });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    if (candidates.length > Math.min(MAX_WANTED_TILES, this.residentLimit)) {
      candidates.length = Math.min(MAX_WANTED_TILES, this.residentLimit);
    }
    const activeCandidates = candidates;

    const wanted = new Set<string>();
    for (const candidate of activeCandidates) {
      const tile = this.tiles.get(candidate.key);
      const step = this.stepForDistance(candidate.distance, options.mode, view.zoom);
      const coverage = this.latestCoverage.get(candidate.key);
      const coverageKey = coverage?.key ?? '';
      if (!tile && coverageKey === FULL_COVERAGE_KEY) continue;
      wanted.add(candidate.key);
      if (tile) {
        tile.lastUsed = now;
        this.ensureTileMesh(tile, step, coverageKey, coverage?.mask);
        this.updateTileVisibility(tile);
      } else if (
        !this.pendingTiles.has(candidate.key)
        && !this.tileFailedRecently(candidate.key, now)
        && this.pendingTiles.size < MAX_PENDING_TILES
      ) {
        void this.loadTile(candidate.rx, candidate.rz, candidate.key, now, step);
      }
    }

    for (const [key, abort] of this.tileAborts) {
      if (wanted.has(key)) continue;
      abort.abort();
      this.tileAborts.delete(key);
      this.pendingTiles.delete(key);
    }
    for (const tile of this.tiles.values()) {
      if (!wanted.has(tile.key) && tile.mesh) tile.mesh.visible = false;
    }
    this.wantedTiles = wanted;
    this.evictTiles(wanted);
    debugLog('top-map', 'update', {
      mode: options.mode,
      candidates: activeCandidates.length,
      totalCandidates: candidates.length,
      resident: this.tiles.size,
      pending: this.pendingTiles.size,
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.manifestSeq++;
    this.abortPendingLoads();
    this.scene.remove(this.group);
    this.pendingTiles.clear();
    this.latestCoverage.clear();
    this.coverageSource = undefined;
    this.clearTiles();
  }

  surfaceYAtChunk(cx: number, cz: number): number | null {
    const blocksPerChunk = 16;
    const worldX = cx * blocksPerChunk + blocksPerChunk / 2;
    const worldZ = cz * blocksPerChunk + blocksPerChunk / 2;
    const rx = Math.floor(worldX / TOP_MAP_TILE_BLOCKS);
    const rz = Math.floor(worldZ / TOP_MAP_TILE_BLOCKS);
    const tile = this.tiles.get(`${rx},${rz}`);
    if (!tile) return null;

    const localX = worldX - tile.data.payload.origin.x;
    const localZ = worldZ - tile.data.payload.origin.z;
    const stride = tile.data.payload.sampleStride;
    const samples = tile.data.payload.size.samples;
    const sx = Math.max(0, Math.min(samples - 1, Math.floor(localX / stride)));
    const sz = Math.max(0, Math.min(samples - 1, Math.floor(localZ / stride)));
    const height = tile.data.prepared.heights[sz * samples + sx];
    return height === TOP_MAP_MISSING_HEIGHT ? null : height;
  }

  diagnosticSnapshot(): TopMapDiagnosticSnapshot {
    return {
      world: this.world,
      dimension: this.dimension,
      enabled: this.topMapEnabled,
      manifestLoaded: this.manifestLoaded,
      availableTiles: this.regionKeys.size,
      pendingTiles: [...this.pendingTiles].sort(),
      wantedTiles: [...this.wantedTiles].sort(),
      residentTiles: [...this.tiles.values()]
        .map((tile) => ({
          key: tile.key,
          step: tile.step,
          coverageKey: tile.coverageKey,
          visible: tile.mesh?.visible ?? false,
          meshBytes: tile.mesh?.userData.meshBytes ?? 0,
          lastUsed: tile.lastUsed,
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    };
  }

  private async loadManifest(world: string, dimension: string, seq: number) {
    const abort = new AbortController();
    this.manifestAbort?.abort();
    this.manifestAbort = abort;
    try {
      const manifest = await fetchTopMapManifest(world, dimension, abort.signal);
      if (this.disposed || seq !== this.manifestSeq || world !== this.world || dimension !== this.dimension) return;
      this.regionKeys = new Set((manifest.hasTopMap ? manifest.topMap?.regions ?? [] : []).map((region) => `${region.x},${region.z}`));
      this.manifestLoaded = true;
      debugLog('top-map', 'manifest-loaded', {
        world,
        dimension,
        tiles: this.regionKeys.size,
        topMapEnabled: this.topMapEnabled && this.regionKeys.size > 0,
      });
    } catch (error) {
      if (isAbortError(error)) return;
      if (this.disposed || seq !== this.manifestSeq || world !== this.world || dimension !== this.dimension) return;
      this.manifestLoaded = true;
      debugLog('top-map', 'manifest-error', { world, dimension, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.manifestAbort === abort) this.manifestAbort = null;
    }
  }

  private async loadTile(
    rx: number,
    rz: number,
    key: string,
    now: number,
    step: number,
  ) {
    if (this.disposed || this.pendingTiles.has(key) || this.tiles.has(key) || !this.topMapEnabled || !this.regionKeys.has(key)) return;
    this.pendingTiles.add(key);
    const abort = new AbortController();
    this.tileAborts.set(key, abort);
    const world = this.world;
    const dimension = this.dimension;
    try {
      const payload = await fetchTopMapTile(world, dimension, rx, rz, abort.signal);
      if (this.disposed || world !== this.world || dimension !== this.dimension || !this.topMapEnabled) return;
      const data = prepareTopMap(payload);
      const tile: TopMapTile = {
        key,
        data,
        mesh: null,
        material: createTopMapMaterial(data.texture, this.shared),
        step: 0,
        coverageKey: '',
        lastUsed: now,
      };
      this.failedTiles.delete(key);
      this.tiles.set(key, tile);
      if (this.wantedTiles.has(key)) {
        const latestCoverage = this.latestCoverage.get(key);
        const latestCoverageKey = latestCoverage?.key ?? '';
        this.ensureTileMesh(tile, this.latestStepForTile(rx, rz), latestCoverageKey, latestCoverage?.mask);
        this.updateTileVisibility(tile);
      }
      debugLog('top-map', 'tile-loaded', { key, rx, rz, chunks: payload.chunks, step, approach: payload.approach });
    } catch (error) {
      if (isAbortError(error)) return;
      if (this.disposed || world !== this.world || dimension !== this.dimension) return;
      this.failedTiles.set(key, performance.now());
      debugLog('top-map', 'tile-error', { key, rx, rz, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.tileAborts.get(key) === abort) {
        this.tileAborts.delete(key);
        this.pendingTiles.delete(key);
      }
    }
  }

  private ensureTileMesh(
    tile: TopMapTile,
    step: number,
    coverageKey: string,
    onlineChunkMask: Uint8Array | undefined,
  ) {
    if (tile.step === step && tile.coverageKey === coverageKey) return;
    const built = buildTileGeometry(tile.data, step, onlineChunkMask);
    tile.step = step;
    tile.coverageKey = coverageKey;
    if (!built) {
      this.disposeTileMesh(tile);
    } else if (tile.mesh) {
      tile.mesh.geometry.dispose();
      tile.mesh.geometry = built.geometry;
      tile.mesh.userData.meshBytes = built.bytes;
    } else {
      tile.mesh = new THREE.Mesh(built.geometry, tile.material);
      tile.mesh.position.set(tile.data.payload.origin.x, 0, tile.data.payload.origin.z);
      tile.mesh.matrixAutoUpdate = false;
      tile.mesh.updateMatrix();
      tile.mesh.userData.meshBytes = built.bytes;
      this.group.add(tile.mesh);
    }
    debugLog('top-map', 'tile-mesh', {
      key: tile.key,
      step,
      coveredChunks: topMapCoverageChunkCount(coverageKey),
      vertices: tile.mesh ? tile.mesh.geometry.getAttribute('position').count : 0,
      bytes: tile.mesh?.userData.meshBytes ?? 0,
    });
  }

  private updateTileVisibility(tile: TopMapTile) {
    if (!tile.mesh) return;
    tile.mesh.visible = true;
  }

  private stepForDistance(distance: number, mode: TopMapUpdateOptions['mode'], zoom: number): number {
    if (mode === 'perspective') {
      if (distance <= FREE_VIEW_LOD2_DISTANCE_BLOCKS) return 2;
      if (distance <= FREE_VIEW_LOD4_DISTANCE_BLOCKS) return 4;
      return 8;
    }
    if (zoom >= LOD2_ZOOM_THRESHOLD) return 2;
    return zoom >= LOD4_ZOOM_THRESHOLD ? 4 : 8;
  }

  private latestStepForTile(rx: number, rz: number): number {
    const centerX = rx * TOP_MAP_TILE_BLOCKS + TOP_MAP_TILE_BLOCKS / 2;
    const centerZ = rz * TOP_MAP_TILE_BLOCKS + TOP_MAP_TILE_BLOCKS / 2;
    return this.stepForDistance(
      Math.hypot(centerX - this.latestCameraX, centerZ - this.latestCameraZ),
      this.latestMode,
      this.latestZoom,
    );
  }

  private tileFailedRecently(key: string, now: number): boolean {
    const failedAt = this.failedTiles.get(key);
    if (failedAt === undefined) return false;
    if (now - failedAt < FAILED_TILE_RETRY_MS) return true;
    this.failedTiles.delete(key);
    return false;
  }

  private evictTiles(wanted: ReadonlySet<string>) {
    if (this.tiles.size <= this.residentLimit) return;
    const stale = [...this.tiles.values()]
      .filter((tile) => !wanted.has(tile.key))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    let resident = this.tiles.size;
    for (const tile of stale) {
      if (resident <= this.residentLimit) break;
      this.removeTile(tile.key);
      resident--;
    }
  }

  private clearTiles() {
    for (const key of [...this.tiles.keys()]) this.removeTile(key);
  }

  private abortPendingLoads() {
    this.manifestAbort?.abort();
    this.manifestAbort = null;
    for (const abort of this.tileAborts.values()) abort.abort();
    this.tileAborts.clear();
  }

  private disposeTileMesh(tile: TopMapTile) {
    if (!tile.mesh) return;
    this.group.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    tile.mesh = null;
  }

  private removeTile(key: string) {
    const tile = this.tiles.get(key);
    if (!tile) return;
    this.disposeTileMesh(tile);
    tile.material.dispose();
    tile.data.texture.dispose();
    this.tiles.delete(key);
  }

  private viewMetrics(camera: THREE.Camera, options: TopMapUpdateOptions): { width: number; height: number; zoom: number } {
    if (options.mode === 'perspective') {
      const size = Math.max(TOP_MAP_TILE_BLOCKS, options.radiusBlocks ?? TOP_MAP_TILE_BLOCKS * 2);
      return { width: size * 2, height: size * 2, zoom: 1 };
    }
    if (camera instanceof THREE.OrthographicCamera) {
      const height = (camera.top - camera.bottom) / camera.zoom;
      const aspect = (camera.right - camera.left) / Math.max(1e-3, camera.top - camera.bottom);
      return { width: height * aspect, height, zoom: camera.zoom };
    }
    if (camera instanceof THREE.PerspectiveCamera) {
      const height = 2 * Math.max(1, camera.position.y) * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
      return { width: height * camera.aspect, height, zoom: TOP_MAP_TILE_BLOCKS / Math.max(1, height) };
    }
    return { width: TOP_MAP_TILE_BLOCKS * 2, height: TOP_MAP_TILE_BLOCKS * 2, zoom: 1 };
  }
}
