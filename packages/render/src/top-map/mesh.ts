import { packNormalizedUint8, packIndices, packNormalizedUint16, boundsOfPositions } from '../meshPacking.js';
import { TOP_MAP_MISSING_HEIGHT, type PreparedTopMapTile } from '@violet-map/core/formats/top-map';
import { type MeshBuffers } from '@violet-map/render';
import { Float32Writer, Uint32Writer } from '../utils.js';

export const TOP_MAP_POSITION_SCALE = [512, 4096, 512] as const;
export const TOP_MAP_POSITION_OFFSET = [0, -2048, 0] as const;

export interface BuildTopMapMeshOptions {
  step: number;
  onlineChunks?: ReadonlySet<string>;
  /** 32x32 local chunk occupancy bitmap (128 bytes), used to avoid allocating
   * thousands of coordinate strings while rebuilding an offline tile. */
  onlineChunkMask?: Uint8Array;
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
const EPS = 1e-4;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
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
  addQuad(
    builder,
    size,
    [
      [ax, topY, az],
      [bx, topY, bz],
      [bx, bottomY, bz],
      [ax, bottomY, az],
    ],
    shade,
    light,
  );
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

function cellHeight(
  cellHeights: Int16Array,
  cellStatus: Uint8Array,
  cellCount: number,
  x: number,
  z: number,
): number | null {
  if (x < 0 || z < 0 || x >= cellCount || z >= cellCount) return null;
  const i = cellIndex(cellCount, x, z);
  return cellStatus[i] !== CELL_STATUS_ABSENT ? cellHeights[i] : null;
}

function chunkKeyForLocal(data: PreparedTopMapTile, x: number, z: number): string {
  const wx = data.payload.origin.x + x;
  const wz = data.payload.origin.z + z;
  return `${Math.floor(wx / 16)},${Math.floor(wz / 16)}`;
}

function buildCells(
  data: PreparedTopMapTile,
  step: number,
  onlineChunks: ReadonlySet<string> | undefined,
  onlineChunkMask: Uint8Array | undefined,
): CellBuildResult {
  const size = data.payload.size.blocks;
  const cellCount = Math.ceil(size / step);
  const cellHeights = new Int16Array(cellCount * cellCount);
  const cellStatus = new Uint8Array(cellCount * cellCount);
  const cellLights = new Float32Array(cellCount * cellCount * 2);
  const bottomApproach = data.payload.approach === 'bottom';
  cellHeights.fill(TOP_MAP_MISSING_HEIGHT);

  const isOnlineCell = (cx: number, cz: number): boolean => {
    if (cx < 0 || cz < 0 || cx >= cellCount || cz >= cellCount) return false;
    if (onlineChunkMask) {
      const chunkX = Math.floor((cx * step) / 16);
      const chunkZ = Math.floor((cz * step) / 16);
      const index = chunkZ * 32 + chunkX;
      return index >= 0 && index < FULL_TILE_CHUNKS && (onlineChunkMask[index >> 3] & (1 << (index & 7))) !== 0;
    }
    if (!onlineChunks) return false;
    return onlineChunks.has(chunkKeyForLocal(data, cx * step, cz * step));
  };

  const hasOfflineNeighbor = (cx: number, cz: number): boolean =>
    !isOnlineCell(cx - 1, cz) || !isOnlineCell(cx + 1, cz) || !isOnlineCell(cx, cz - 1) || !isOnlineCell(cx, cz + 1);

  for (let cz = 0; cz < cellCount; cz++) {
    for (let cx = 0; cx < cellCount; cx++) {
      const index = cellIndex(cellCount, cx, cz);
      const x0 = cx * step;
      const z0 = cz * step;
      const currentOnline = isOnlineCell(cx, cz);
      const onlineBoundaryCell =
        (onlineChunkMask !== undefined || onlineChunks !== undefined) && currentOnline && hasOfflineNeighbor(cx, cz);
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

function topShade(
  cellHeights: Int16Array,
  cellStatus: Uint8Array,
  cellCount: number,
  cx: number,
  cz: number,
  h: number,
): number {
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

/**
 * Build a stepped terrain tile, omitting online chunks except seam cells.
 * The returned geometry is tile-local and null when no offline surface remains.
 */
export function buildTopMapMesh(data: PreparedTopMapTile, opts: BuildTopMapMeshOptions): MeshBuffers | null {
  const step = Math.max(1, Math.floor(opts.step));
  if (!Number.isFinite(step)) return null;
  const size = data.payload.size.blocks;
  const { cellCount, cellHeights, cellStatus, cellLights } = buildCells(
    data,
    step,
    opts.onlineChunks,
    opts.onlineChunkMask,
  );
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

      addQuad(
        builder,
        size,
        [
          [x0, h, z0],
          [x1, h, z0],
          [x1, h, z1],
          [x0, h, z1],
        ],
        topShade(cellHeights, cellStatus, cellCount, cx, cz, h),
        light,
        flipTop,
      );

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
