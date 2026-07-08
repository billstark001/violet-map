import * as THREE from 'three';
import {
  buildTopMapMesh,
  prepareTopMapTile,
  topMapCoverageChunkCount,
  topMapCoverageKeyForTile,
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
const FAILED_TILE_RETRY_MS = 12000;
const FULL_COVERAGE_KEY = '*';

export interface TopMapUpdateOptions {
  mode: 'perspective' | 'top';
  radiusBlocks?: number;
  onlineChunks?: ReadonlySet<string>;
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

function buildTileMesh(
  data: TopMapData,
  step: number,
  onlineChunks: ReadonlySet<string> | undefined,
  shared: SharedUniforms,
): THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null {
  const buffers = buildTopMapMesh(data.prepared, { step, onlineChunks });
  if (!buffers || buffers.positions.length === 0 || buffers.indices.length === 0) return null;
  const built = buildGeometry(buffers);
  const material = createTopMapMaterial(data.texture, shared);
  const mesh = new THREE.Mesh(built.geometry, material);
  mesh.position.set(data.payload.origin.x, 0, data.payload.origin.z);
  mesh.frustumCulled = false;
  mesh.userData.meshBytes = built.bytes;
  return mesh;
}

export class TopMapManager {
  private readonly group = new THREE.Group();
  private readonly tiles = new Map<string, TopMapTile>();
  private readonly pendingTiles = new Set<string>();
  private world = '';
  private dimension = '';
  private topMapEnabled = false;
  private manifestLoaded = false;
  private manifestSeq = 0;
  private regionKeys = new Set<string>();
  private failedTiles = new Map<string, number>();
  private wantedTiles = new Set<string>();
  private latestStep = 8;
  private latestOnlineChunks: ReadonlySet<string> | undefined;

  constructor(private readonly scene: THREE.Scene, private readonly shared: SharedUniforms) {
    this.group.visible = false;
    scene.add(this.group);
  }

  configure(world: string, dimension: string, topMapEnabled: boolean) {
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
    this.regionKeys.clear();
    this.group.visible = topMapEnabled;
    this.pendingTiles.clear();
    this.failedTiles.clear();
    this.wantedTiles.clear();
    this.latestOnlineChunks = undefined;
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

    const view = this.viewMetrics(camera, options);
    const step = options.mode === 'perspective' || view.zoom >= LOD4_ZOOM_THRESHOLD ? 4 : 8;
    this.latestStep = step;
    this.latestOnlineChunks = options.onlineChunks;
    this.group.visible = true;
    const radiusX = view.width / 2 + TOP_MAP_TILE_BLOCKS;
    const radiusZ = view.height / 2 + TOP_MAP_TILE_BLOCKS;
    const minRx = Math.floor((camera.position.x - radiusX) / TOP_MAP_TILE_BLOCKS);
    const maxRx = Math.floor((camera.position.x + radiusX) / TOP_MAP_TILE_BLOCKS);
    const minRz = Math.floor((camera.position.z - radiusZ) / TOP_MAP_TILE_BLOCKS);
    const maxRz = Math.floor((camera.position.z + radiusZ) / TOP_MAP_TILE_BLOCKS);
    const candidates: { rx: number; rz: number; key: string; distance: number }[] = [];

    for (let rz = minRz; rz <= maxRz; rz++) {
      for (let rx = minRx; rx <= maxRx; rx++) {
        const key = `${rx},${rz}`;
        if (!this.regionKeys.has(key)) continue;
        const centerX = rx * TOP_MAP_TILE_BLOCKS + TOP_MAP_TILE_BLOCKS / 2;
        const centerZ = rz * TOP_MAP_TILE_BLOCKS + TOP_MAP_TILE_BLOCKS / 2;
        candidates.push({
          rx,
          rz,
          key,
          distance: Math.hypot(centerX - camera.position.x, centerZ - camera.position.z),
        });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    const activeCandidates = candidates.slice(0, MAX_WANTED_TILES);

    const wanted = new Set<string>();
    for (const candidate of activeCandidates) {
      const tile = this.tiles.get(candidate.key);
      const coverageKey = topMapCoverageKeyForTile(candidate.rx, candidate.rz, options.onlineChunks);
      if (!tile && coverageKey === FULL_COVERAGE_KEY) continue;
      wanted.add(candidate.key);
      if (tile) {
        tile.lastUsed = now;
        this.ensureTileMesh(tile, step, coverageKey, options.onlineChunks);
        this.updateTileVisibility(tile);
      } else if (
        !this.pendingTiles.has(candidate.key)
        && !this.tileFailedRecently(candidate.key, now)
        && this.pendingTiles.size < MAX_PENDING_TILES
      ) {
        void this.loadTile(candidate.rx, candidate.rz, candidate.key, now, step, coverageKey, options.onlineChunks);
      }
    }

    for (const tile of this.tiles.values()) {
      if (!wanted.has(tile.key) && tile.mesh) tile.mesh.visible = false;
    }
    this.wantedTiles = wanted;
    this.evictTiles(wanted);
    debugLog('top-map', 'update', {
      mode: options.mode,
      step,
      candidates: activeCandidates.length,
      totalCandidates: candidates.length,
      resident: this.tiles.size,
      pending: this.pendingTiles.size,
    });
  }

  dispose() {
    this.scene.remove(this.group);
    this.pendingTiles.clear();
    this.clearTiles();
  }

  private async loadManifest(world: string, dimension: string, seq: number) {
    try {
      const manifest = await fetchTopMapManifest(world, dimension);
      if (seq !== this.manifestSeq || world !== this.world || dimension !== this.dimension) return;
      this.regionKeys = new Set((manifest.hasTopMap ? manifest.topMap?.regions ?? [] : []).map((region) => `${region.x},${region.z}`));
      this.manifestLoaded = true;
      debugLog('top-map', 'manifest-loaded', {
        world,
        dimension,
        tiles: this.regionKeys.size,
        topMapEnabled: this.topMapEnabled && this.regionKeys.size > 0,
      });
    } catch (error) {
      if (seq !== this.manifestSeq || world !== this.world || dimension !== this.dimension) return;
      this.manifestLoaded = true;
      debugLog('top-map', 'manifest-error', { world, dimension, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async loadTile(
    rx: number,
    rz: number,
    key: string,
    now: number,
    step: number,
    coverageKey: string,
    onlineChunks: ReadonlySet<string> | undefined,
  ) {
    if (this.pendingTiles.has(key) || this.tiles.has(key) || !this.topMapEnabled || !this.regionKeys.has(key)) return;
    this.pendingTiles.add(key);
    const world = this.world;
    const dimension = this.dimension;
    try {
      const payload = await fetchTopMapTile(world, dimension, rx, rz);
      if (world !== this.world || dimension !== this.dimension || !this.topMapEnabled) return;
      const tile: TopMapTile = {
        key,
        data: prepareTopMap(payload),
        mesh: null,
        step: 0,
        coverageKey: '',
        lastUsed: now,
      };
      this.failedTiles.delete(key);
      this.tiles.set(key, tile);
      if (this.wantedTiles.has(key)) {
        const latestOnlineChunks = this.latestOnlineChunks ?? onlineChunks;
        const latestCoverageKey = topMapCoverageKeyForTile(rx, rz, latestOnlineChunks);
        this.ensureTileMesh(tile, this.latestStep || step, latestCoverageKey, latestOnlineChunks);
        this.updateTileVisibility(tile);
      }
      debugLog('top-map', 'tile-loaded', { key, rx, rz, chunks: payload.chunks, step, approach: payload.approach });
    } catch (error) {
      this.failedTiles.set(key, performance.now());
      debugLog('top-map', 'tile-error', { key, rx, rz, error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.pendingTiles.delete(key);
    }
  }

  private ensureTileMesh(
    tile: TopMapTile,
    step: number,
    coverageKey: string,
    onlineChunks: ReadonlySet<string> | undefined,
  ) {
    if (tile.step === step && tile.coverageKey === coverageKey) return;
    this.disposeTileMesh(tile);
    tile.step = step;
    tile.coverageKey = coverageKey;
    tile.mesh = buildTileMesh(tile.data, step, onlineChunks, this.shared);
    if (tile.mesh) this.group.add(tile.mesh);
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

  private tileFailedRecently(key: string, now: number): boolean {
    const failedAt = this.failedTiles.get(key);
    if (failedAt === undefined) return false;
    if (now - failedAt < FAILED_TILE_RETRY_MS) return true;
    this.failedTiles.delete(key);
    return false;
  }

  private evictTiles(wanted: ReadonlySet<string>) {
    if (this.tiles.size <= MAX_RESIDENT_TILES) return;
    const stale = [...this.tiles.values()]
      .filter((tile) => !wanted.has(tile.key))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    let resident = this.tiles.size;
    for (const tile of stale) {
      if (resident <= MAX_RESIDENT_TILES) break;
      this.removeTile(tile.key);
      resident--;
    }
  }

  private clearTiles() {
    for (const key of [...this.tiles.keys()]) this.removeTile(key);
  }

  private disposeTileMesh(tile: TopMapTile) {
    if (!tile.mesh) return;
    this.group.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    tile.mesh.material.dispose();
    tile.mesh = null;
  }

  private removeTile(key: string) {
    const tile = this.tiles.get(key);
    if (!tile) return;
    this.disposeTileMesh(tile);
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
