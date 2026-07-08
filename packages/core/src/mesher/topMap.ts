import { AIR_NAMES, ChunkColumn } from '../world.js';
import { BlockInfo, BlockStateRef, MeshBuffers } from '../types.js';
import type { Rgb } from '../colors.js';
import { Float32Writer, Uint32Writer } from '../utils.js';

export const TOP_MAP_SCHEMA = 6;
export const TOP_MAP_TILE_BLOCKS = 512;
export const TOP_MAP_MISSING_HEIGHT = -32768;
export const TOP_MAP_POSITION_SCALE = [512, 4096, 512] as const;
export const TOP_MAP_POSITION_OFFSET = [0, -2048, 0] as const;

export type TopMapApproach = 'top' | 'bottom';
export type TopMapLightMode = 'stored-first' | 'rebake';

export interface TopMapRegionManifestEntry {
  x: number;
  z: number;
  hash: string;
}

export interface TopMapRegionSourceEntry extends TopMapRegionManifestEntry {
  empty: boolean;
}

export interface TopMapTileSetManifest {
  tileSizeBlocks: number;
  sampleStride: number;
  colorStride: number;
  lightStride: number;
  colorVersion: number;
  lightVersion: number;
  approach: TopMapApproach;
  lightMode: TopMapLightMode;
  format: 'msgpack';
  regions: TopMapRegionManifestEntry[];
  sources: TopMapRegionSourceEntry[];
}

export interface TopMapDimensionManifest {
  hasTopMap: boolean;
  topMap?: TopMapTileSetManifest;
}

export interface TopMapManifest {
  schema: 6;
  generatedAt: string;
  world: string;
  dimensions: Record<string, TopMapDimensionManifest>;
}

export interface TopMapTilePayload {
  schema: 6;
  kind: 'topmap-region';
  dimension: string;
  approach: TopMapApproach;
  region: { x: number; z: number };
  origin: { x: number; z: number };
  size: { blocks: number; samples: number; colorSamples: number; lightSamples: number };
  sampleStride: number;
  colorStride: number;
  lightStride: number;
  chunks: number;
  minY: number;
  maxY: number;
  heightEncoding: 'int16le';
  colorEncoding: 'rgba8888';
  lightEncoding: 'sky-block-u4';
  heights: Uint8Array;
  colors: Uint8Array;
  lights: Uint8Array;
}

export interface PreparedTopMapTile {
  payload: TopMapTilePayload;
  heights: Int16Array;
  colors: Uint8Array;
  lights: Uint8Array;
}

export interface TopMapSurfaceOptions {
  approach: TopMapApproach;
  infoOf(name: string): BlockInfo;
  colorOf(state: BlockStateRef, biome: string): Rgb;
}

export interface TopMapSurfaceSample {
  y: number;
  state: BlockStateRef;
  biome: string;
  color: Rgb;
  sky: number;
  block: number;
}

export interface BuildTopMapMeshOptions {
  step: number;
  onlineChunks?: ReadonlySet<string>;
}

interface TopMapMeshBuilder {
  positions: Float32Writer;
  uvs: Float32Writer;
  colors: Float32Writer;
  lights: Float32Writer;
  indices: Uint32Writer;
  verts: number;
}

interface CellBuildResult {
  cellCount: number;
  cellHeights: Int16Array;
  cellStatus: Uint8Array;
  cellLights: Float32Array;
}

const CELL_STATUS_ABSENT = 0;
const CELL_STATUS_PRESENT = 1;
const CELL_STATUS_ONLINE_BOUNDARY = 2;
const FULL_TILE_CHUNKS = 32 * 32;
const FULL_COVERAGE_KEY = '*';
const EPS = 1e-4;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clampLight(value: number): number {
  return Math.min(15, Math.max(0, Math.round(value)));
}

function localName(name: string): string {
  return name.includes(':') ? name.split(':')[1] : name;
}

function isTransparentOverlay(state: BlockStateRef, info: BlockInfo): boolean {
  if (info.fluid || info.layer === 'translucent') return true;
  const local = localName(state.name);
  return local.includes('glass') || local.includes('ice') || local.includes('water');
}

function transparentAlpha(state: BlockStateRef, info: BlockInfo): number {
  const local = localName(state.name);
  if (info.fluid || local.includes('water')) return 0.58;
  if (local.includes('ice')) return 0.28;
  if (local.includes('glass')) return 0.42;
  if (info.layer === 'translucent') return 0.45;
  return 0.35;
}

function mixColor(base: Rgb, over: Rgb, alpha: number): Rgb {
  const a = clamp01(alpha);
  return [
    base[0] * (1 - a) + over[0] * a,
    base[1] * (1 - a) + over[1] * a,
    base[2] * (1 - a) + over[2] * a,
  ];
}

function applyTransparentLayers(base: Rgb, layers: { color: Rgb; alpha: number }[]): Rgb {
  let color = base;
  for (let i = layers.length - 1; i >= 0; i--) color = mixColor(color, layers[i].color, layers[i].alpha);
  return color;
}

export function sampleTopMapSurface(
  col: ChunkColumn,
  x: number,
  z: number,
  opts: TopMapSurfaceOptions,
): TopMapSurfaceSample | null {
  const top = opts.approach === 'top';
  const start = top ? col.maxY - 1 : col.minY;
  const end = top ? col.minY - 1 : col.maxY;
  const delta = top ? -1 : 1;
  const layers: { color: Rgb; alpha: number }[] = [];
  let surfaceY = 0;
  let surfaceState: BlockStateRef | null = null;
  let surfaceBiome = 'minecraft:plains';
  let baseColor: Rgb | null = null;

  for (let y = start; y !== end; y += delta) {
    const state = col.getBlock(x, y, z);
    if (AIR_NAMES.has(state.name)) continue;
    const biome = col.getBiome(x, y, z);
    const info = opts.infoOf(state.name);
    if (!surfaceState) {
      surfaceY = y;
      surfaceState = state;
      surfaceBiome = biome;
    }
    if (isTransparentOverlay(state, info)) {
      layers.push({ color: opts.colorOf(state, biome), alpha: transparentAlpha(state, info) });
      continue;
    }
    baseColor = opts.colorOf(state, biome);
    break;
  }

  if (!surfaceState) return null;
  const color = baseColor
    ? applyTransparentLayers(baseColor, layers)
    : applyTransparentLayers(layers.at(-1)?.color ?? opts.colorOf(surfaceState, surfaceBiome), layers.slice(0, -1));
  const lightY = top ? surfaceY + 1 : surfaceY - 1;
  return {
    y: surfaceY,
    state: surfaceState,
    biome: surfaceBiome,
    color,
    sky: clampLight(col.getSkyLight(x, lightY, z)),
    block: clampLight(col.getBlockLight(x, lightY, z)),
  };
}

function decodeInt16Le(bytes: Uint8Array, count: number): Int16Array {
  if (bytes.byteLength !== count * 2) throw new Error(`bad top-map height payload size: ${bytes.byteLength}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

export function prepareTopMapTile(payload: TopMapTilePayload): PreparedTopMapTile {
  const heightPixels = payload.size.samples * payload.size.samples;
  const colorPixels = payload.size.colorSamples * payload.size.colorSamples;
  const lightPixels = payload.size.lightSamples * payload.size.lightSamples;
  if (
    payload.schema !== TOP_MAP_SCHEMA
    || payload.kind !== 'topmap-region'
    || (payload.approach !== 'top' && payload.approach !== 'bottom')
    || payload.heightEncoding !== 'int16le'
    || payload.colorEncoding !== 'rgba8888'
    || payload.lightEncoding !== 'sky-block-u4'
    || payload.size.blocks !== TOP_MAP_TILE_BLOCKS
    || payload.sampleStride < 1
    || payload.colorStride < 1
    || payload.lightStride < 1
    || payload.size.samples !== Math.floor(payload.size.blocks / payload.sampleStride)
    || payload.size.colorSamples !== Math.floor(payload.size.blocks / payload.colorStride)
    || payload.size.lightSamples !== Math.floor(payload.size.blocks / payload.lightStride)
    || payload.heights.byteLength !== heightPixels * 2
    || payload.colors.byteLength !== colorPixels * 4
    || payload.lights.byteLength !== lightPixels * 2
  ) {
    throw new Error(`bad top-map tile payload for region ${payload.region.x},${payload.region.z}`);
  }
  return {
    payload,
    heights: decodeInt16Le(payload.heights, heightPixels),
    colors: payload.colors.byteOffset === 0 && payload.colors.byteLength === payload.colors.buffer.byteLength
      ? payload.colors
      : new Uint8Array(payload.colors),
    lights: payload.lights.byteOffset === 0 && payload.lights.byteLength === payload.lights.buffer.byteLength
      ? payload.lights
      : new Uint8Array(payload.lights),
  };
}

function packNormalizedUint8(values: Float32Array): Uint8Array {
  const out = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Math.round(clamp01(values[i]) * 255);
  return out;
}

function packNormalizedUint16(values: Float32Array): Uint16Array {
  const out = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Math.round(clamp01(values[i]) * 65535);
  return out;
}

function packTopMapPositions(values: Float32Array): Uint16Array {
  const out = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i += 3) {
    out[i] = Math.round(clamp01((values[i] - TOP_MAP_POSITION_OFFSET[0]) / TOP_MAP_POSITION_SCALE[0]) * 65535);
    out[i + 1] = Math.round(clamp01((values[i + 1] - TOP_MAP_POSITION_OFFSET[1]) / TOP_MAP_POSITION_SCALE[1]) * 65535);
    out[i + 2] = Math.round(clamp01((values[i + 2] - TOP_MAP_POSITION_OFFSET[2]) / TOP_MAP_POSITION_SCALE[2]) * 65535);
  }
  return out;
}

function packIndices(values: Uint32Array, vertexCount: number): Uint16Array | Uint32Array {
  if (vertexCount > 65535) return values;
  const out = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = values[i];
  return out;
}

function boundsOfPositions(values: Float32Array): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < values.length; i += 3) {
    min[0] = Math.min(min[0], values[i]);
    min[1] = Math.min(min[1], values[i + 1]);
    min[2] = Math.min(min[2], values[i + 2]);
    max[0] = Math.max(max[0], values[i]);
    max[1] = Math.max(max[1], values[i + 1]);
    max[2] = Math.max(max[2], values[i + 2]);
  }
  return { min, max };
}

function createBuilder(): TopMapMeshBuilder {
  return {
    positions: new Float32Writer(4096 * 3),
    uvs: new Float32Writer(4096 * 2),
    colors: new Float32Writer(4096 * 3),
    lights: new Float32Writer(4096 * 2),
    indices: new Uint32Writer(4096 * 6),
    verts: 0,
  };
}

function buildBuffers(builder: TopMapMeshBuilder): MeshBuffers {
  const positions = builder.positions.view();
  const uvs = builder.uvs.view();
  const colors = builder.colors.view();
  const lights = builder.lights.view();
  const indices = builder.indices.view();
  return {
    positions: packTopMapPositions(positions),
    uvs: packNormalizedUint16(uvs),
    colors: packNormalizedUint8(colors),
    lights: packNormalizedUint8(lights),
    indices: packIndices(indices, builder.verts),
    bounds: boundsOfPositions(positions),
  };
}

function uvCoord(value: number, size: number): number {
  return clamp(value / size, 0, 1);
}

function addVertex(
  builder: TopMapMeshBuilder,
  size: number,
  x: number,
  y: number,
  z: number,
  shade: number,
  light: readonly [number, number],
) {
  builder.positions.push3(x, y, z);
  builder.uvs.push2(uvCoord(x, size), uvCoord(z, size));
  builder.colors.push3(shade, shade, shade);
  builder.lights.push2(light[0], light[1]);
  builder.verts++;
}

function addQuad(
  builder: TopMapMeshBuilder,
  size: number,
  verts: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ],
  shade: number,
  light: readonly [number, number],
  flip = false,
) {
  const base = builder.verts;
  for (const [x, y, z] of verts) addVertex(builder, size, x, y, z, shade, light);
  if (flip) builder.indices.push6(base, base + 1, base + 2, base, base + 2, base + 3);
  else builder.indices.push6(base, base + 2, base + 1, base, base + 3, base + 2);
}

function addWall(
  builder: TopMapMeshBuilder,
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
  if (topY <= bottomY + EPS) return;
  addQuad(builder, size, [
    [ax, topY, az],
    [bx, topY, bz],
    [bx, bottomY, bz],
    [ax, bottomY, az],
  ], shade, light);
}

function sampleIndex(data: PreparedTopMapTile, x: number, z: number): number {
  const stride = data.payload.sampleStride;
  const samples = data.payload.size.samples;
  const sx = clamp(Math.floor(x / stride), 0, samples - 1);
  const sz = clamp(Math.floor(z / stride), 0, samples - 1);
  return sz * samples + sx;
}

function sampleHeight(data: PreparedTopMapTile, x: number, z: number): number {
  return data.heights[sampleIndex(data, x, z)];
}

function sampleLight(data: PreparedTopMapTile, x: number, z: number): [number, number] {
  const stride = data.payload.lightStride;
  const samples = data.payload.size.lightSamples;
  const sx = clamp(Math.floor(x / stride), 0, samples - 1);
  const sz = clamp(Math.floor(z / stride), 0, samples - 1);
  const offset = (sz * samples + sx) * 2;
  return [data.lights[offset] / 15, data.lights[offset + 1] / 15];
}

function cellIndex(cellCount: number, x: number, z: number): number {
  return z * cellCount + x;
}

function cellHeight(cellHeights: Int16Array, cellStatus: Uint8Array, cellCount: number, x: number, z: number): number | null {
  if (x < 0 || z < 0 || x >= cellCount || z >= cellCount) return null;
  const i = cellIndex(cellCount, x, z);
  return cellStatus[i] !== CELL_STATUS_ABSENT ? cellHeights[i] : null;
}

function chunkKeyForLocal(data: PreparedTopMapTile, x: number, z: number): string {
  const wx = data.payload.origin.x + x;
  const wz = data.payload.origin.z + z;
  return `${Math.floor(wx / 16)},${Math.floor(wz / 16)}`;
}

export function topMapCoverageKeyForTile(
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

export function topMapCoverageChunkCount(coverageKey: string): number {
  if (!coverageKey) return 0;
  if (coverageKey === FULL_COVERAGE_KEY) return FULL_TILE_CHUNKS;
  return coverageKey.split('.').length;
}

function buildCells(
  data: PreparedTopMapTile,
  step: number,
  onlineChunks: ReadonlySet<string> | undefined,
): CellBuildResult {
  const size = data.payload.size.blocks;
  const cellCount = Math.floor(size / step);
  const cellHeights = new Int16Array(cellCount * cellCount);
  const cellStatus = new Uint8Array(cellCount * cellCount);
  const cellLights = new Float32Array(cellCount * cellCount * 2);
  const bottomApproach = data.payload.approach === 'bottom';
  cellHeights.fill(TOP_MAP_MISSING_HEIGHT);

  const isOnlineCell = (cx: number, cz: number): boolean => {
    if (!onlineChunks) return false;
    if (cx < 0 || cz < 0 || cx >= cellCount || cz >= cellCount) return false;
    return onlineChunks.has(chunkKeyForLocal(data, cx * step, cz * step));
  };

  const hasOfflineNeighbor = (cx: number, cz: number): boolean => (
    !isOnlineCell(cx - 1, cz)
    || !isOnlineCell(cx + 1, cz)
    || !isOnlineCell(cx, cz - 1)
    || !isOnlineCell(cx, cz + 1)
  );

  for (let cz = 0; cz < cellCount; cz++) {
    for (let cx = 0; cx < cellCount; cx++) {
      const index = cellIndex(cellCount, cx, cz);
      const x0 = cx * step;
      const z0 = cz * step;
      const currentOnline = isOnlineCell(cx, cz);
      const onlineBoundaryCell = onlineChunks !== undefined && currentOnline && hasOfflineNeighbor(cx, cz);
      if (currentOnline && !onlineBoundaryCell) continue;

      const x1 = Math.min(size, x0 + step);
      const z1 = Math.min(size, z0 + step);
      let height = 0;
      let sampleCount = 0;
      let sky = 0;
      let block = 0;

      for (let z = z0; z < z1; z += data.payload.sampleStride) {
        for (let x = x0; x < x1; x += data.payload.sampleStride) {
          const h = sampleHeight(data, x, z);
          if (h <= TOP_MAP_MISSING_HEIGHT) continue;
          const light = sampleLight(data, x, z);
          sky += light[0];
          block += light[1];
          if (sampleCount === 0) {
            height = h;
          } else if (onlineBoundaryCell) {
            height = bottomApproach ? Math.max(height, h) : Math.min(height, h);
          } else {
            height += h;
          }
          sampleCount++;
        }
      }

      if (sampleCount > 0) {
        cellStatus[index] = onlineBoundaryCell ? CELL_STATUS_ONLINE_BOUNDARY : CELL_STATUS_PRESENT;
        cellHeights[index] = onlineBoundaryCell ? height : Math.round(height / sampleCount);
        cellLights[index * 2] = sky / sampleCount;
        cellLights[index * 2 + 1] = block / sampleCount;
      }
    }
  }

  return { cellCount, cellHeights, cellStatus, cellLights };
}

function topShade(cellHeights: Int16Array, cellStatus: Uint8Array, cellCount: number, cx: number, cz: number, h: number): number {
  const north = cellHeight(cellHeights, cellStatus, cellCount, cx, cz - 1) ?? h;
  const south = cellHeight(cellHeights, cellStatus, cellCount, cx, cz + 1) ?? h;
  const west = cellHeight(cellHeights, cellStatus, cellCount, cx - 1, cz) ?? h;
  const east = cellHeight(cellHeights, cellStatus, cellCount, cx + 1, cz) ?? h;
  return clamp(0.94 + (south - north) * 0.004 + (west - east) * 0.0025, 0.72, 1.08);
}

function cellLight(cellLights: Float32Array, cellCount: number, cx: number, cz: number): [number, number] {
  const i = cellIndex(cellCount, cx, cz) * 2;
  return [cellLights[i], cellLights[i + 1]];
}

export function buildTopMapMesh(data: PreparedTopMapTile, opts: BuildTopMapMeshOptions): MeshBuffers | null {
  const step = Math.max(1, Math.floor(opts.step));
  if (!Number.isFinite(step)) return null;
  const size = data.payload.size.blocks;
  const { cellCount, cellHeights, cellStatus, cellLights } = buildCells(data, step, opts.onlineChunks);
  const skirtBaseY = data.payload.minY - 16;
  const builder = createBuilder();
  const flipTop = data.payload.approach === 'bottom';

  for (let cz = 0; cz < cellCount; cz++) {
    for (let cx = 0; cx < cellCount; cx++) {
      const index = cellIndex(cellCount, cx, cz);
      if (cellStatus[index] !== CELL_STATUS_PRESENT) continue;
      const h = cellHeights[index];
      const x0 = cx * step;
      const z0 = cz * step;
      const x1 = Math.min(size, x0 + step);
      const z1 = Math.min(size, z0 + step);
      const light = cellLight(cellLights, cellCount, cx, cz);

      addQuad(builder, size, [
        [x0, h, z0],
        [x1, h, z0],
        [x1, h, z1],
        [x0, h, z1],
      ], topShade(cellHeights, cellStatus, cellCount, cx, cz, h), light, flipTop);

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
  return buildBuffers(builder);
}
