import * as THREE from 'three';
import {
  fetchTopMapHeightMapTile,
  fetchTopMapManifest,
  type HeightMapTilePayload,
} from '../api';
import { debugLog } from '../logger';
import { createTopMapMaterial, type SharedUniforms } from './materials';

const TILE_BLOCKS = 512;
const TOP_MAP_SCHEMA = 5;
const MAX_RESIDENT_TILES = 96;
const MAX_WANTED_TILES = 96;
const MAX_PENDING_TILES = 6;
const LOD4_ZOOM_THRESHOLD = 1.15;
const MISSING_HEIGHT = -32768;
const FAILED_TILE_RETRY_MS = 12000;
const FULL_TILE_CHUNKS = 32 * 32;
const FULL_COVERAGE_KEY = '*';

const CELL_STATUS_ABSENT = 0;
const CELL_STATUS_PRESENT = 1;
const CELL_STATUS_ONLINE_BOUNDARY = 2;

export interface TopMapUpdateOptions {
  mode: 'perspective' | 'top';
  radiusBlocks?: number;
  onlineChunks?: ReadonlySet<string>;
  hasSkyLight?: boolean;
}

interface HeightMapData {
  payload: HeightMapTilePayload;
  heights: Int16Array;
  texture: THREE.DataTexture;
}

interface HeightMapTile {
  key: string;
  data: HeightMapData;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null;
  step: number;
  coverageKey: string;
  lightKey: string;
  lastUsed: number;
}

interface MeshBuilder {
  positions: number[];
  uvs: number[];
  colors: number[];
  lights: number[];
  indices: number[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function decodeInt16Le(bytes: Uint8Array, count: number): Int16Array {
  if (bytes.byteLength !== count * 2) {
    throw new Error(`bad height payload size: ${bytes.byteLength}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

function prepareHeightMap(payload: HeightMapTilePayload): HeightMapData {
  const heightPixels = payload.size.samples * payload.size.samples;
  const colorPixels = payload.size.colorSamples * payload.size.colorSamples;
  if (
    payload.schema !== TOP_MAP_SCHEMA
    || payload.kind !== 'heightmap-region'
    || payload.heightEncoding !== 'int16le'
    || payload.colorEncoding !== 'rgba8888'
    || payload.size.blocks !== TILE_BLOCKS
    || payload.sampleStride < 1
    || payload.colorStride < 1
    || payload.size.samples !== Math.floor(payload.size.blocks / payload.sampleStride)
    || payload.size.colorSamples !== Math.floor(payload.size.blocks / payload.colorStride)
    || payload.heights.byteLength !== heightPixels * 2
    || payload.colors.byteLength !== colorPixels * 4
  ) {
    throw new Error(`bad top-map heightmap payload for region ${payload.region.x},${payload.region.z}`);
  }
  const textureData = payload.colors.byteOffset === 0 && payload.colors.byteLength === payload.colors.buffer.byteLength
    ? payload.colors
    : new Uint8Array(payload.colors);
  const texture = new THREE.DataTexture(
    textureData,
    payload.size.colorSamples,
    payload.size.colorSamples,
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
  return {
    payload,
    heights: decodeInt16Le(payload.heights, heightPixels),
    texture,
  };
}

function sampleIndex(data: HeightMapData, x: number, z: number): number {
  const stride = data.payload.sampleStride;
  const samples = data.payload.size.samples;
  const sx = clamp(Math.floor(x / stride), 0, samples - 1);
  const sz = clamp(Math.floor(z / stride), 0, samples - 1);
  return sz * samples + sx;
}

function sampleHeight(data: HeightMapData, x: number, z: number): number {
  return data.heights[sampleIndex(data, x, z)];
}

function cellIndex(cellCount: number, x: number, z: number): number {
  return z * cellCount + x;
}

function cellHeight(cellHeights: Int16Array, cellStatus: Uint8Array, cellCount: number, x: number, z: number): number | null {
  if (x < 0 || z < 0 || x >= cellCount || z >= cellCount) return null;
  const i = cellIndex(cellCount, x, z);
  return cellStatus[i] !== CELL_STATUS_ABSENT ? cellHeights[i] : null;
}

function uvX(x: number, size: number): number {
  return clamp(x / size, 0, 1);
}

function uvZ(z: number, size: number): number {
  return clamp(z / size, 0, 1);
}

function addVertex(
  builder: MeshBuilder,
  size: number,
  x: number,
  y: number,
  z: number,
  shade: number,
  light: readonly [number, number],
): number {
  const index = builder.positions.length / 3;
  builder.positions.push(x, y, z);
  builder.uvs.push(uvX(x, size), uvZ(z, size));
  builder.colors.push(shade, shade, shade);
  builder.lights.push(light[0], light[1]);
  return index;
}

function addQuad(
  builder: MeshBuilder,
  size: number,
  verts: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ],
  shade: number,
  light: readonly [number, number],
) {
  const base = builder.positions.length / 3;
  for (const [x, y, z] of verts) addVertex(builder, size, x, y, z, shade, light);
  builder.indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
}

function addWall(
  builder: MeshBuilder,
  size: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  topY: number,
  bottomY: number,
  shade: number,
  light: readonly [number, number],
) {
  if (topY <= bottomY) return;
  addQuad(builder, size, [
    [ax, topY, az],
    [bx, topY, bz],
    [bx, bottomY, bz],
    [ax, bottomY, az],
  ], shade, light);
}

function chunkKeyForLocal(data: HeightMapData, x: number, z: number): string {
  const wx = data.payload.origin.x + x;
  const wz = data.payload.origin.z + z;
  return `${Math.floor(wx / 16)},${Math.floor(wz / 16)}`;
}

function coverageKeyForTile(
  rx: number,
  rz: number,
  onlineChunks: ReadonlySet<string> | undefined,
): string {
  if (!onlineChunks?.size) return '';
  const parts: string[] = [];
  const minCx = rx * 32;
  const minCz = rz * 32;
  for (let dz = 0; dz < 32; dz++) {
    for (let dx = 0; dx < 32; dx++) {
      if (onlineChunks.has(`${minCx + dx},${minCz + dz}`)) parts.push((dz * 32 + dx).toString(36));
    }
  }
  if (parts.length === FULL_TILE_CHUNKS) return FULL_COVERAGE_KEY;
  return parts.join('.');
}

function coverageChunkCount(coverageKey: string): number {
  if (!coverageKey) return 0;
  if (coverageKey === FULL_COVERAGE_KEY) return FULL_TILE_CHUNKS;
  return coverageKey.split('.').length;
}

function buildCells(
  data: HeightMapData,
  step: number,
  onlineChunks: ReadonlySet<string> | undefined,
): { cellCount: number; cellHeights: Int16Array; cellStatus: Uint8Array } {
  const size = data.payload.size.blocks;
  const cellCount = Math.floor(size / step);
  const cellHeights = new Int16Array(cellCount * cellCount);
  const cellStatus = new Uint8Array(cellCount * cellCount);

  cellHeights.fill(MISSING_HEIGHT);

  const isOnlineCell = (cx: number, cz: number): boolean => {
    if (!onlineChunks) return false;

    // 边界外视为 onlineChunks 不存在
    if (cx < 0 || cz < 0 || cx >= cellCount || cz >= cellCount) {
      return false;
    }

    return onlineChunks.has(chunkKeyForLocal(data, cx * step, cz * step));
  };

  const hasOfflineNeighbor = (cx: number, cz: number): boolean => {
    return (
      !isOnlineCell(cx - 1, cz) ||
      !isOnlineCell(cx + 1, cz) ||
      !isOnlineCell(cx, cz - 1) ||
      !isOnlineCell(cx, cz + 1)
    );
  };

  for (let cz = 0; cz < cellCount; cz++) {
    for (let cx = 0; cx < cellCount; cx++) {
      const index = cellIndex(cellCount, cx, cz);
      const x0 = cx * step;
      const z0 = cz * step;

      const currentOnline = isOnlineCell(cx, cz);
      const onlineBoundaryCell =
        onlineChunks !== undefined && currentOnline && hasOfflineNeighbor(cx, cz);

      // onlineChunks 中的非边界格子仍然跳过
      if (currentOnline && !onlineBoundaryCell) continue;

      const x1 = Math.min(size, x0 + step);
      const z1 = Math.min(size, z0 + step);

      let height = 0;
      let sampleCount = 0;

      for (let z = z0; z < z1; z += data.payload.sampleStride) {
        for (let x = x0; x < x1; x += data.payload.sampleStride) {
          if (sampleCount === 0) {
            height = sampleHeight(data, x, z);
          } else if (onlineBoundaryCell) {
            height = Math.min(height, sampleHeight(data, x, z));
          } else {
            height += sampleHeight(data, x, z);
          }
          sampleCount++;
        }
      }

      if (sampleCount > 0) {
        cellStatus[index] = onlineBoundaryCell ? CELL_STATUS_ONLINE_BOUNDARY : CELL_STATUS_PRESENT;
        cellHeights[index] = onlineBoundaryCell ? height : height / sampleCount;
      }
    }
  }

  return { cellCount, cellHeights, cellStatus };
}

function topShade(cellHeights: Int16Array, cellStatus: Uint8Array, cellCount: number, cx: number, cz: number, h: number): number {
  const north = cellHeight(cellHeights, cellStatus, cellCount, cx, cz - 1) ?? h;
  const south = cellHeight(cellHeights, cellStatus, cellCount, cx, cz + 1) ?? h;
  const west = cellHeight(cellHeights, cellStatus, cellCount, cx - 1, cz) ?? h;
  const east = cellHeight(cellHeights, cellStatus, cellCount, cx + 1, cz) ?? h;
  return clamp(0.94 + (south - north) * 0.004 + (west - east) * 0.0025, 0.72, 1.08);
}

function buildHeightMapMesh(
  data: HeightMapData,
  step: number,
  onlineChunks: ReadonlySet<string> | undefined,
  shared: SharedUniforms,
  light: readonly [number, number],
): THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null {
  const size = data.payload.size.blocks;
  const { cellCount, cellHeights, cellStatus } = buildCells(data, step, onlineChunks);
  const skirtBaseY = data.payload.minY - 16;
  const builder: MeshBuilder = { positions: [], uvs: [], colors: [], lights: [], indices: [] };

  for (let cz = 0; cz < cellCount; cz++) {
    for (let cx = 0; cx < cellCount; cx++) {
      const index = cellIndex(cellCount, cx, cz);
      if (cellStatus[index] !== CELL_STATUS_PRESENT) continue;
      const h = cellHeights[index];
      const x0 = cx * step;
      const z0 = cz * step;
      const x1 = Math.min(size, x0 + step);
      const z1 = Math.min(size, z0 + step);

      addQuad(builder, size, [
        [x0, h, z0],
        [x1, h, z0],
        [x1, h, z1],
        [x0, h, z1],
      ], topShade(cellHeights, cellStatus, cellCount, cx, cz, h), light);

      const north = cellHeight(cellHeights, cellStatus, cellCount, cx, cz - 1);
      const south = cellHeight(cellHeights, cellStatus, cellCount, cx, cz + 1);
      const west = cellHeight(cellHeights, cellStatus, cellCount, cx - 1, cz);
      const east = cellHeight(cellHeights, cellStatus, cellCount, cx + 1, cz);
      if (north !== null) addWall(builder, size, x1, z0, x0, z0, h, north, 0.62, light);
      if (south !== null) addWall(builder, size, x0, z1, x1, z1, h, south, 0.76, light);
      if (west !== null) addWall(builder, size, x0, z0, x0, z1, h, west, 0.55, light);
      if (east !== null) addWall(builder, size, x1, z1, x1, z0, h, east, 0.68, light);
      if (cz === 0) addWall(builder, size, x1, z0, x0, z0, h, skirtBaseY, 0.62, light);
      if (cz === cellCount - 1) addWall(builder, size, x0, z1, x1, z1, h, skirtBaseY, 0.76, light);
      if (cx === 0) addWall(builder, size, x0, z0, x0, z1, h, skirtBaseY, 0.55, light);
      if (cx === cellCount - 1) addWall(builder, size, x1, z1, x1, z0, h, skirtBaseY, 0.68, light);
    }
  }

  if (!builder.indices.length) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(builder.positions), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(builder.uvs), 2));
  geometry.setAttribute('tintColor', new THREE.BufferAttribute(new Float32Array(builder.colors), 3));
  geometry.setAttribute('lightData', new THREE.BufferAttribute(new Float32Array(builder.lights), 2));
  geometry.setIndex(new THREE.BufferAttribute(
    builder.positions.length / 3 > 65535 ? new Uint32Array(builder.indices) : new Uint16Array(builder.indices),
    1,
  ));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const material = createTopMapMaterial(data.texture, shared);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(data.payload.origin.x, 0, data.payload.origin.z);
  mesh.frustumCulled = false;
  return mesh;
}

export class TopMapManager {
  private readonly heightGroup = new THREE.Group();
  private readonly heightTiles = new Map<string, HeightMapTile>();
  private readonly pendingHeight = new Set<string>();
  private world = '';
  private dimension = '';
  private heightMapEnabled = false;
  private manifestLoaded = false;
  private manifestSeq = 0;
  private heightRegionKeys = new Set<string>();
  private failedHeight = new Map<string, number>();
  private wantedHeight = new Set<string>();
  private latestStep = 8;
  private latestHasSkyLight = true;
  private latestOnlineChunks: ReadonlySet<string> | undefined;

  constructor(private readonly scene: THREE.Scene, private readonly shared: SharedUniforms) {
    this.heightGroup.visible = false;
    scene.add(this.heightGroup);
  }

  configure(world: string, dimension: string, heightMapEnabled: boolean) {
    if (
      this.world === world
      && this.dimension === dimension
      && this.heightMapEnabled === heightMapEnabled
    ) return;
    this.world = world;
    this.dimension = dimension;
    this.heightMapEnabled = heightMapEnabled;
    this.manifestLoaded = !heightMapEnabled;
    this.manifestSeq++;
    this.heightRegionKeys.clear();
    this.heightGroup.visible = heightMapEnabled;
    this.pendingHeight.clear();
    this.failedHeight.clear();
    this.wantedHeight.clear();
    this.latestOnlineChunks = undefined;
    this.latestHasSkyLight = true;
    this.clearHeightTiles();
    debugLog('top-map', 'configure', { world, dimension, heightMapEnabled: heightMapEnabled });
    if (heightMapEnabled) void this.loadManifest(world, dimension, this.manifestSeq);
  }

  update(camera: THREE.Camera, now: number, options: TopMapUpdateOptions) {
    const heightMapAllowed = this.heightMapEnabled
      && (!this.manifestLoaded || this.heightRegionKeys.size > 0);
    if (!heightMapAllowed || !this.world) {
      this.heightGroup.visible = false;
      return;
    }
    if (!this.manifestLoaded) {
      this.heightGroup.visible = false;
      return;
    }

    const view = this.viewMetrics(camera, options);
    const step = options.mode === 'perspective' || view.zoom >= LOD4_ZOOM_THRESHOLD ? 4 : 8;
    const hasSkyLight = options.hasSkyLight !== false;
    this.latestStep = step;
    this.latestHasSkyLight = hasSkyLight;
    this.latestOnlineChunks = options.onlineChunks;
    this.heightGroup.visible = true;
    const radiusX = view.width / 2 + TILE_BLOCKS;
    const radiusZ = view.height / 2 + TILE_BLOCKS;
    const minRx = Math.floor((camera.position.x - radiusX) / TILE_BLOCKS);
    const maxRx = Math.floor((camera.position.x + radiusX) / TILE_BLOCKS);
    const minRz = Math.floor((camera.position.z - radiusZ) / TILE_BLOCKS);
    const maxRz = Math.floor((camera.position.z + radiusZ) / TILE_BLOCKS);
    const candidates: { rx: number; rz: number; key: string; distance: number }[] = [];

    for (let rz = minRz; rz <= maxRz; rz++) {
      for (let rx = minRx; rx <= maxRx; rx++) {
        const key = `${rx},${rz}`;
        if (!this.heightRegionKeys.has(key)) continue;
        const centerX = rx * TILE_BLOCKS + TILE_BLOCKS / 2;
        const centerZ = rz * TILE_BLOCKS + TILE_BLOCKS / 2;
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
      const tile = this.heightTiles.get(candidate.key);
      const coverageKey = coverageKeyForTile(candidate.rx, candidate.rz, options.onlineChunks);
      if (!tile && coverageKey === FULL_COVERAGE_KEY) continue;
      wanted.add(candidate.key);
      if (tile) {
        tile.lastUsed = now;
        this.ensureTileMesh(tile, step, coverageKey, hasSkyLight, options.onlineChunks);
        this.updateTileVisibility(tile);
      } else if (
        !this.pendingHeight.has(candidate.key)
        && !this.tileFailedRecently(candidate.key, now)
        && this.pendingHeight.size < MAX_PENDING_TILES
      ) {
        void this.loadHeightTile(candidate.rx, candidate.rz, candidate.key, now, step, coverageKey, hasSkyLight, options.onlineChunks);
      }
    }

    for (const tile of this.heightTiles.values()) {
      if (!wanted.has(tile.key) && tile.mesh) tile.mesh.visible = false;
    }
    this.wantedHeight = wanted;
    this.evictHeightTiles(wanted);
    debugLog('top-map', 'update', {
      mode: options.mode,
      step,
      candidates: activeCandidates.length,
      totalCandidates: candidates.length,
      resident: this.heightTiles.size,
      pending: this.pendingHeight.size,
    });
  }

  dispose() {
    this.scene.remove(this.heightGroup);
    this.pendingHeight.clear();
    this.clearHeightTiles();
  }

  private async loadManifest(world: string, dimension: string, seq: number) {
    try {
      const manifest = await fetchTopMapManifest(world, dimension);
      if (seq !== this.manifestSeq || world !== this.world || dimension !== this.dimension) return;
      this.heightRegionKeys = new Set((manifest.hasHeightMap ? manifest.heightMap?.regions ?? [] : []).map((region) => `${region.x},${region.z}`));
      this.manifestLoaded = true;
      debugLog('top-map', 'manifest-loaded', {
        world,
        dimension,
        heightTiles: this.heightRegionKeys.size,
        heightMapEnabled: this.heightMapEnabled && this.heightRegionKeys.size > 0,
      });
    } catch (error) {
      if (seq !== this.manifestSeq || world !== this.world || dimension !== this.dimension) return;
      this.manifestLoaded = true;
      debugLog('top-map', 'manifest-error', { world, dimension, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async loadHeightTile(
    rx: number,
    rz: number,
    key: string,
    now: number,
    step: number,
    coverageKey: string,
    hasSkyLight: boolean,
    onlineChunks: ReadonlySet<string> | undefined,
  ) {
    if (this.pendingHeight.has(key) || this.heightTiles.has(key) || !this.heightMapEnabled || !this.heightRegionKeys.has(key)) return;
    this.pendingHeight.add(key);
    const world = this.world;
    const dimension = this.dimension;
    try {
      const payload = await fetchTopMapHeightMapTile(world, dimension, rx, rz);
      if (world !== this.world || dimension !== this.dimension || !this.heightMapEnabled) return;
      const tile: HeightMapTile = {
        key,
        data: prepareHeightMap(payload),
        mesh: null,
        step: 0,
        coverageKey: '',
        lightKey: '',
        lastUsed: now,
      };
      this.failedHeight.delete(key);
      this.heightTiles.set(key, tile);
      if (this.wantedHeight.has(key)) {
        const latestOnlineChunks = this.latestOnlineChunks ?? onlineChunks;
        const latestCoverageKey = coverageKeyForTile(rx, rz, latestOnlineChunks);
        this.ensureTileMesh(tile, this.latestStep || step, latestCoverageKey, this.latestHasSkyLight ?? hasSkyLight, latestOnlineChunks);
        this.updateTileVisibility(tile);
      }
      debugLog('top-map', 'height-tile-loaded', { key, rx, rz, chunks: payload.chunks, step });
    } catch (error) {
      this.failedHeight.set(key, performance.now());
      debugLog('top-map', 'height-tile-error', { key, rx, rz, error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.pendingHeight.delete(key);
    }
  }

  private ensureTileMesh(
    tile: HeightMapTile,
    step: number,
    coverageKey: string,
    hasSkyLight: boolean,
    onlineChunks: ReadonlySet<string> | undefined,
  ) {
    const lightKey = hasSkyLight ? 'sky' : 'block';
    if (tile.step === step && tile.coverageKey === coverageKey && tile.lightKey === lightKey) return;
    this.disposeTileMesh(tile);
    tile.step = step;
    tile.coverageKey = coverageKey;
    tile.lightKey = lightKey;
    tile.mesh = buildHeightMapMesh(tile.data, step, onlineChunks, this.shared, hasSkyLight ? [1, 0] : [0, 1]);
    if (tile.mesh) this.heightGroup.add(tile.mesh);
    debugLog('top-map', 'height-tile-mesh', {
      key: tile.key,
      step,
      coveredChunks: coverageChunkCount(coverageKey),
      vertices: tile.mesh ? tile.mesh.geometry.getAttribute('position').count : 0,
    });
  }

  private updateTileVisibility(tile: HeightMapTile) {
    if (!tile.mesh) return;
    tile.mesh.visible = true;
  }

  private tileFailedRecently(key: string, now: number): boolean {
    const failedAt = this.failedHeight.get(key);
    if (failedAt === undefined) return false;
    if (now - failedAt < FAILED_TILE_RETRY_MS) return true;
    this.failedHeight.delete(key);
    return false;
  }

  private evictHeightTiles(wanted: ReadonlySet<string>) {
    if (this.heightTiles.size <= MAX_RESIDENT_TILES) return;
    const stale = [...this.heightTiles.values()]
      .filter((tile) => !wanted.has(tile.key))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    let resident = this.heightTiles.size;
    for (const tile of stale) {
      if (resident <= MAX_RESIDENT_TILES) break;
      this.removeHeightTile(tile.key);
      resident--;
    }
  }

  private clearHeightTiles() {
    for (const key of [...this.heightTiles.keys()]) this.removeHeightTile(key);
  }

  private disposeTileMesh(tile: HeightMapTile) {
    if (!tile.mesh) return;
    this.heightGroup.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    tile.mesh.material.dispose();
    tile.mesh = null;
  }

  private removeHeightTile(key: string) {
    const tile = this.heightTiles.get(key);
    if (!tile) return;
    this.disposeTileMesh(tile);
    tile.data.texture.dispose();
    this.heightTiles.delete(key);
  }

  private viewMetrics(camera: THREE.Camera, options: TopMapUpdateOptions): { width: number; height: number; zoom: number } {
    if (options.mode === 'perspective') {
      const size = Math.max(TILE_BLOCKS, options.radiusBlocks ?? TILE_BLOCKS * 2);
      return { width: size * 2, height: size * 2, zoom: 1 };
    }
    if (camera instanceof THREE.OrthographicCamera) {
      const height = (camera.top - camera.bottom) / camera.zoom;
      const aspect = (camera.right - camera.left) / Math.max(1e-3, camera.top - camera.bottom);
      return { width: height * aspect, height, zoom: camera.zoom };
    }
    if (camera instanceof THREE.PerspectiveCamera) {
      const height = 2 * Math.max(1, camera.position.y) * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
      return { width: height * camera.aspect, height, zoom: 512 / Math.max(1, height) };
    }
    return { width: TILE_BLOCKS * 2, height: TILE_BLOCKS * 2, zoom: 1 };
  }
}
