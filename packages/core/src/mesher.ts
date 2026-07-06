import { ModelBaker, BakedQuad, MISSING_TEXTURE } from './model.js';
import { AIR, AIR_NAMES, ChunkColumn } from './world.js';
import {
  AtlasIndex, AtlasRect, BlockInfo, BlockStateRef, Direction, DIR_VEC, MeshBuffers, RenderLayer,
  SectionMeshes, TextureAlphaMap, TintType,
} from './types.js';
import type { Rgb } from './colors.js';
import { Float32Writer, Uint32Writer } from './meshBufferBuilder.js';

export interface WorldView {
  getBlock(x: number, y: number, z: number): BlockStateRef;
  getBiome(x: number, y: number, z: number): string;
  getSkyLight(x: number, y: number, z: number): number;
  getBlockLight(x: number, y: number, z: number): number;
}

/** 3x3 邻域，供跨区块面剔除 / AO / 平滑光照。 */
export class ChunkNeighborhood implements WorldView {
  private grid: (ChunkColumn | null)[] = new Array(9).fill(null);
  constructor(readonly baseX: number, readonly baseZ: number) { }
  set(col: ChunkColumn) {
    const gx = col.x - this.baseX, gz = col.z - this.baseZ;
    if (gx >= 0 && gx < 3 && gz >= 0 && gz < 3) this.grid[gx + gz * 3] = col;
  }
  private colAt(x: number, z: number): ChunkColumn | null {
    const gx = (x >> 4) - this.baseX, gz = (z >> 4) - this.baseZ;
    if (gx < 0 || gx > 2 || gz < 0 || gz > 2) return null;
    return this.grid[gx + gz * 3];
  }
  getBlock(x: number, y: number, z: number) { return this.colAt(x, z)?.getBlock(x & 15, y, z & 15) ?? AIR; }
  getBiome(x: number, y: number, z: number) { return this.colAt(x, z)?.getBiome(x & 15, y, z & 15) ?? 'minecraft:plains'; }
  getSkyLight(x: number, y: number, z: number) { return this.colAt(x, z)?.getSkyLight(x & 15, y, z & 15) ?? 15; }
  getBlockLight(x: number, y: number, z: number) { return this.colAt(x, z)?.getBlockLight(x & 15, y, z & 15) ?? 0; }
}

export interface MesherResources {
  baker: ModelBaker;
  info(name: string): BlockInfo;
  tint(type: TintType, fixed: number | undefined, biome: string): Rgb;
  atlas: AtlasIndex;
  textureHasAlpha?: TextureAlphaMap;
}

const SHADE: Record<Direction, number> = { up: 1, down: 0.5, north: 0.8, south: 0.8, west: 0.6, east: 0.6 };
const OCCLUSION_DIRECTIONS: Direction[] = ['down', 'up', 'north', 'south', 'west', 'east'];
export const SECTION_VISIBILITY_DIRECTIONS: Direction[] = ['down', 'up', 'north', 'south', 'west', 'east'];
const AO_FACTOR = [0.4, 0.6, 0.8, 1.0];
// 每个面的两个切向轴（坐标分量下标）
const TANGENTS: Record<Direction, [number, number]> = {
  up: [0, 2], down: [0, 2], north: [0, 1], south: [0, 1], west: [1, 2], east: [1, 2],
};
const WHITE: Rgb = [1, 1, 1];
const UV_EPS = 1e-4;
const HEIGHT_EPS = 1e-3;
const GEOMETRY_EPS = 1e-4;
const FULL_FACE_UVS = new Float32Array([0, 0, 16, 0, 16, 16, 0, 16]);
const FULL_FACE_POSITIONS: Record<Direction, Float32Array> = {
  up: new Float32Array([0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1]),
  down: new Float32Array([0, 0, 1, 1, 0, 1, 1, 0, 0, 0, 0, 0]),
  north: new Float32Array([1, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0]),
  south: new Float32Array([0, 1, 1, 1, 1, 1, 1, 0, 1, 0, 0, 1]),
  west: new Float32Array([0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0]),
  east: new Float32Array([1, 1, 1, 1, 1, 0, 1, 0, 0, 1, 0, 1]),
};

type SimpleCubeDef = Record<Direction, BakedQuad>;

interface GreedyCell {
  key: string;
  rect: AtlasRect;
  r: number;
  g: number;
  b: number;
  sky: number;
  block: number;
}

interface GreedyGrid {
  dir: Direction;
  slice: number;
  cells: (GreedyCell | null)[];
}

/** 原版风格的坐标散列，用于随机变体选择。 */
export function hash3(x: number, y: number, z: number): number {
  let h = (Math.imul(x, 3129871) ^ Math.imul(z, 116129781) ^ y) | 0;
  h = (Math.imul(h, Math.imul(h, 42317861)) + Math.imul(h, 11)) | 0;
  return h >>> 16;
}

class MeshBuilder {
  pos = new Float32Writer(4096 * 3);
  uv = new Float32Writer(4096 * 2);
  atlas: Float32Writer | null;
  col = new Float32Writer(4096 * 3);
  light = new Float32Writer(4096 * 2);
  idx = new Uint32Writer(4096 * 6);
  verts = 0;
  constructor(withAtlasRects = false) {
    this.atlas = withAtlasRects ? new Float32Writer(4096 * 4) : null;
  }
  get empty() { return this.verts === 0; }
  vertex(
    x: number, y: number, z: number, u: number, v: number,
    r: number, g: number, b: number, sky: number, block: number,
    atlasRect?: AtlasRect,
  ) {
    this.pos.push3(x, y, z);
    this.uv.push2(u, v);
    if (this.atlas) {
      const rect = atlasRect ?? { u0: 0, v0: 0, u1: 0, v1: 0 };
      this.atlas.push4(rect.u0, rect.v0, rect.u1, rect.v1);
    }
    this.col.push3(r, g, b);
    this.light.push2(sky, block);
    this.verts++;
  }
  quadIndices() {
    const b = this.verts - 4;
    this.idx.push6(b, b + 2, b + 1, b, b + 3, b + 2);
  }
  build(): MeshBuffers {
    return {
      positions: this.pos.toArray(), uvs: this.uv.toArray(),
      atlasRects: this.atlas?.toArray(),
      colors: this.col.toArray(), lights: this.light.toArray(),
      indices: this.idx.toArray(),
    };
  }
}

function atlasUv(rect: AtlasRect, u: number, v: number): [number, number] {
  const tu = Math.min(16 - UV_EPS, Math.max(UV_EPS, u));
  const tv = Math.min(16 - UV_EPS, Math.max(UV_EPS, v));
  return [
    rect.u0 + (tu / 16) * (rect.u1 - rect.u0),
    rect.v0 + (tv / 16) * (rect.v1 - rect.v0),
  ];
}

function smoothVertexLight(
  res: MesherResources, view: WorldView, q: BakedQuad, vi: number,
  bx: number, by: number, bz: number,
): { sky: number; block: number; ao: number } {
  const [a1, a2] = TANGENTS[q.face];
  const c1 = q.positions[vi * 3 + a1] > 0.5 ? 1 : -1;
  const c2 = q.positions[vi * 3 + a2] > 0.5 ? 1 : -1;
  const off = (axis: number, s: number): [number, number, number] => {
    const o: [number, number, number] = [0, 0, 0];
    o[axis] = s;
    return o;
  };
  const o1 = off(a1, c1), o2 = off(a2, c2);
  const cells: [number, number, number][] = [
    [bx, by, bz],
    [bx + o1[0], by + o1[1], bz + o1[2]],
    [bx + o2[0], by + o2[1], bz + o2[2]],
    [bx + o1[0] + o2[0], by + o1[1] + o2[1], bz + o1[2] + o2[2]],
  ];
  const occ = cells.map((c, i) => i > 0 && res.info(view.getBlock(c[0], c[1], c[2]).name).occludes);
  let sky = 0, block = 0, count = 0;
  for (let i = 0; i < 4; i++) {
    if (i > 0 && occ[i]) continue;
    if (i === 3 && occ[1] && occ[2]) continue;
    sky += view.getSkyLight(cells[i][0], cells[i][1], cells[i][2]);
    block += view.getBlockLight(cells[i][0], cells[i][1], cells[i][2]);
    count++;
  }
  const s1 = occ[1] ? 1 : 0, s2 = occ[2] ? 1 : 0, co = occ[3] ? 1 : 0;
  const aoLevel = s1 && s2 ? 0 : 3 - (s1 + s2 + co);
  return { sky: sky / Math.max(count, 1) / 15, block: block / Math.max(count, 1) / 15, ao: AO_FACTOR[aoLevel] };
}

function emitQuad(
  res: MesherResources, view: WorldView, builder: MeshBuilder, q: BakedQuad,
  lx: number, ly: number, lz: number, wx: number, wy: number, wz: number,
  tint: Rgb, smooth: boolean,
) {
  const rect = res.atlas[q.texture] ?? res.atlas[MISSING_TEXTURE];
  const shade = q.shade ? SHADE[q.face] : 1;
  const d = DIR_VEC[q.face];
  const outside = q.cullFace !== null;
  const bx = outside ? wx + d[0] : wx;
  const by = outside ? wy + d[1] : wy;
  const bz = outside ? wz + d[2] : wz;
  let flatSky = 0, flatBlock = 0;
  if (!smooth || !outside) {
    flatSky = view.getSkyLight(bx, by, bz) / 15;
    flatBlock = view.getBlockLight(bx, by, bz) / 15;
    if (!outside) {
      flatSky = Math.max(flatSky, view.getSkyLight(wx + d[0], wy + d[1], wz + d[2]) / 15);
      flatBlock = Math.max(flatBlock, view.getBlockLight(wx + d[0], wy + d[1], wz + d[2]) / 15);
    }
  }
  for (let i = 0; i < 4; i++) {
    let sky = flatSky, block = flatBlock, ao = 1;
    if (smooth && outside && q.ao) {
      const s = smoothVertexLight(res, view, q, i, bx, by, bz);
      sky = s.sky; block = s.block; ao = s.ao;
    }
    const m = shade * ao;
    const [u, v] = atlasUv(rect, q.uvs[i * 2], q.uvs[i * 2 + 1]);
    builder.vertex(
      lx + q.positions[i * 3], ly + q.positions[i * 3 + 1], lz + q.positions[i * 3 + 2],
      u, v,
      tint[0] * m, tint[1] * m, tint[2] * m, sky, block,
    );
  }
  builder.quadIndices();
}

function arrayMatches(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > GEOMETRY_EPS) return false;
  }
  return true;
}

function isDefaultCubeFace(q: BakedQuad, dir: Direction): boolean {
  return q.face === dir
    && q.cullFace === dir
    && q.tintIndex < 0
    && arrayMatches(q.positions, FULL_FACE_POSITIONS[dir])
    && arrayMatches(q.uvs, FULL_FACE_UVS);
}

function simpleCubeFromQuads(quads: BakedQuad[], textureHasAlpha?: TextureAlphaMap): SimpleCubeDef | null {
  if (quads.length !== SECTION_VISIBILITY_DIRECTIONS.length) return null;
  const faces: Partial<SimpleCubeDef> = {};
  for (const q of quads) {
    if (!isDefaultCubeFace(q, q.face)) return null;
    if (textureHasAlpha?.[q.texture]) return null;
    if (faces[q.face]) return null;
    faces[q.face] = q;
  }
  for (const dir of SECTION_VISIBILITY_DIRECTIONS) {
    if (!faces[dir]) return null;
  }
  return faces as SimpleCubeDef;
}

function quantByte(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

function greedyCellForQuad(
  res: MesherResources, view: WorldView, q: BakedQuad,
  wx: number, wy: number, wz: number, smooth: boolean,
): GreedyCell | null {
  const rect = res.atlas[q.texture] ?? res.atlas[MISSING_TEXTURE];
  if (!rect) return null;
  const shade = q.shade ? SHADE[q.face] : 1;
  const d = DIR_VEC[q.face];
  const bx = wx + d[0], by = wy + d[1], bz = wz + d[2];
  const flatSky = view.getSkyLight(bx, by, bz) / 15;
  const flatBlock = view.getBlockLight(bx, by, bz) / 15;
  let key = '';
  let out: GreedyCell | null = null;
  for (let i = 0; i < 4; i++) {
    let sky = flatSky, block = flatBlock, ao = 1;
    if (smooth && q.ao) {
      const s = smoothVertexLight(res, view, q, i, bx, by, bz);
      sky = s.sky; block = s.block; ao = s.ao;
    }
    const r = quantByte(shade * ao);
    const g = r;
    const b = r;
    const skyQ = quantByte(sky);
    const blockQ = quantByte(block);
    const vertexKey = `${q.texture}|${r}|${g}|${b}|${skyQ}|${blockQ}`;
    if (i === 0) {
      key = vertexKey;
      out = { key, rect, r: r / 255, g: g / 255, b: b / 255, sky: skyQ / 255, block: blockQ / 255 };
    } else if (vertexKey !== key) {
      return null;
    }
  }
  return out;
}

function greedyCoords(dir: Direction, x: number, y: number, z: number): { slice: number; u: number; v: number } {
  switch (dir) {
    case 'up': return { slice: y + 1, u: x, v: z };
    case 'down': return { slice: y, u: x, v: z };
    case 'north': return { slice: z, u: x, v: y };
    case 'south': return { slice: z + 1, u: x, v: y };
    case 'west': return { slice: x, u: z, v: y };
    case 'east': return { slice: x + 1, u: z, v: y };
  }
}

function addGreedyCell(
  grids: Map<string, GreedyGrid>,
  dir: Direction, slice: number, u: number, v: number, cell: GreedyCell,
) {
  const key = `${dir}:${slice}`;
  let grid = grids.get(key);
  if (!grid) {
    grid = { dir, slice, cells: new Array<GreedyCell | null>(16 * 16).fill(null) };
    grids.set(key, grid);
  }
  grid.cells[v * 16 + u] = cell;
}

function greedyCellsEqual(a: GreedyCell | null, b: GreedyCell | null): boolean {
  return !!a && !!b && a.key === b.key;
}

function emitGreedyQuad(
  builder: MeshBuilder, dir: Direction, slice: number,
  u0: number, u1: number, v0: number, v1: number, cell: GreedyCell,
) {
  let verts: [number, number, number][];
  switch (dir) {
    case 'up':
      verts = [[u0, slice, v0], [u1, slice, v0], [u1, slice, v1], [u0, slice, v1]];
      break;
    case 'down':
      verts = [[u0, slice, v1], [u1, slice, v1], [u1, slice, v0], [u0, slice, v0]];
      break;
    case 'north':
      verts = [[u1, v1, slice], [u0, v1, slice], [u0, v0, slice], [u1, v0, slice]];
      break;
    case 'south':
      verts = [[u0, v1, slice], [u1, v1, slice], [u1, v0, slice], [u0, v0, slice]];
      break;
    case 'west':
      verts = [[slice, v1, u0], [slice, v1, u1], [slice, v0, u1], [slice, v0, u0]];
      break;
    case 'east':
      verts = [[slice, v1, u1], [slice, v1, u0], [slice, v0, u0], [slice, v0, u1]];
      break;
  }
  const w = u1 - u0;
  const h = v1 - v0;
  const uvs: [number, number][] = [[0, 0], [w, 0], [w, h], [0, h]];
  for (let i = 0; i < 4; i++) {
    const [x, y, z] = verts[i];
    const [u, v] = uvs[i];
    builder.vertex(x, y, z, u, v, cell.r, cell.g, cell.b, cell.sky, cell.block, cell.rect);
  }
  builder.quadIndices();
}

function flushGreedyGrids(grids: Map<string, GreedyGrid>, builder: MeshBuilder) {
  for (const grid of grids.values()) {
    const used = new Uint8Array(16 * 16);
    for (let v = 0; v < 16; v++) {
      for (let u = 0; u < 16; u++) {
        const idx = v * 16 + u;
        const start = grid.cells[idx];
        if (!start || used[idx]) continue;
        let width = 1;
        while (u + width < 16) {
          const nextIdx = v * 16 + u + width;
          if (used[nextIdx] || !greedyCellsEqual(start, grid.cells[nextIdx])) break;
          width++;
        }
        let height = 1;
        grow: while (v + height < 16) {
          for (let du = 0; du < width; du++) {
            const nextIdx = (v + height) * 16 + u + du;
            if (used[nextIdx] || !greedyCellsEqual(start, grid.cells[nextIdx])) break grow;
          }
          height++;
        }
        for (let dv = 0; dv < height; dv++) {
          for (let du = 0; du < width; du++) used[(v + dv) * 16 + u + du] = 1;
        }
        emitGreedyQuad(builder, grid.dir, grid.slice, u, u + width, v, v + height, start);
      }
    }
  }
}

function isSameFluid(res: MesherResources, texture: string, state: BlockStateRef): boolean {
  const bi = res.info(state.name);
  if (bi.fluid?.texture === texture) return true;
  return (state.properties.waterlogged === 'true' || !!bi.waterlogged) && texture.includes('water');
}

function fullyOccluded(res: MesherResources, view: WorldView, wx: number, wy: number, wz: number): boolean {
  for (const dir of OCCLUSION_DIRECTIONS) {
    const d = DIR_VEC[dir];
    if (!res.info(view.getBlock(wx + d[0], wy + d[1], wz + d[2]).name).occludes) return false;
  }
  return true;
}

function emitFluid(
  res: MesherResources, view: WorldView, builders: Record<RenderLayer, MeshBuilder>,
  fluid: NonNullable<BlockInfo['fluid']>, state: BlockStateRef,
  lx: number, ly: number, lz: number, wx: number, wy: number, wz: number,
) {
  const builder = builders[fluid.layer ?? 'translucent'];
  const rect = res.atlas[fluid.texture] ?? res.atlas[MISSING_TEXTURE];
  const tint = res.tint(fluid.tint, undefined, view.getBiome(wx, wy, wz));
  const above = view.getBlock(wx, wy + 1, wz);
  const aboveSame = isSameFluid(res, fluid.texture, above);
  const aboveOccludes = res.info(above.name).occludes;
  const sky = view.getSkyLight(wx, wy, wz) / 15;
  const block = view.getBlockLight(wx, wy, wz) / 15;

  const fluidLevelHeight = (s: BlockStateRef): number => {
    const level = Number(s.properties.level ?? '0');
    if (!Number.isFinite(level) || level <= 0 || level >= 8) return 14 / 16;
    return Math.max(1 / 16, (8 - level) / 9);
  };
  const surfaceHeightAt = (x: number, z: number): number => {
    const s = x === wx && z === wz ? state : view.getBlock(x, wy, z);
    if (!isSameFluid(res, fluid.texture, s)) return 0;
    const a = view.getBlock(x, wy + 1, z);
    if (isSameFluid(res, fluid.texture, a) || res.info(a.name).occludes) return 1;
    return fluidLevelHeight(s);
  };
  const cornerHeight = (x: number, z: number, dx: -1 | 1, dz: -1 | 1): number => {
    if (surfaceHeightAt(x, z) >= 1) return 1;
    const samples = [
      surfaceHeightAt(x, z),
      surfaceHeightAt(x + dx, z),
      surfaceHeightAt(x, z + dz),
      surfaceHeightAt(x + dx, z + dz),
    ].filter((h) => h > 0);
    if (!samples.length) return surfaceHeightAt(x, z);
    return samples.reduce((a, b) => a + b, 0) / samples.length;
  };
  const hNW = cornerHeight(wx, wz, -1, -1);
  const hNE = cornerHeight(wx, wz, 1, -1);
  const hSE = cornerHeight(wx, wz, 1, 1);
  const hSW = cornerHeight(wx, wz, -1, 1);

  const faceUv = (dir: Direction, v: [number, number, number]): [number, number] => {
    switch (dir) {
      case 'down': return [v[0] * 16, 16 - v[2] * 16];
      case 'up': return [v[0] * 16, v[2] * 16];
      case 'north': return [16 - v[0] * 16, 16 - v[1] * 16];
      case 'south': return [v[0] * 16, 16 - v[1] * 16];
      case 'west': return [v[2] * 16, 16 - v[1] * 16];
      case 'east': return [16 - v[2] * 16, 16 - v[1] * 16];
    }
  };

  const face = (dir: Direction, verts: [number, number, number][]) => {
    const shade = SHADE[dir];
    verts.forEach((v) => {
      const [u, vv] = atlasUv(rect, ...faceUv(dir, v));
      builder.vertex(
        lx + v[0], ly + v[1], lz + v[2], u, vv,
        tint[0] * shade, tint[1] * shade, tint[2] * shade, sky, block,
      );
    });
    builder.quadIndices();
  };
  const neighbor = (dir: Direction) => {
    const d = DIR_VEC[dir];
    return view.getBlock(wx + d[0], wy + d[1], wz + d[2]);
  };
  const shouldDraw = (dir: Direction) => {
    const n = neighbor(dir);
    if (isSameFluid(res, fluid.texture, n)) return false;
    return !res.info(n.name).occludes;
  };
  const side = (
    dir: Direction,
    top: [[number, number, number], [number, number, number]],
    bottomWhenAir: [[number, number, number], [number, number, number]],
    neighborBottom: () => [[number, number, number], [number, number, number]],
  ) => {
    const n = neighbor(dir);
    if (isSameFluid(res, fluid.texture, n)) {
      const bottom = neighborBottom();
      const visible = top[0][1] > bottom[0][1] + HEIGHT_EPS || top[1][1] > bottom[1][1] + HEIGHT_EPS;
      if (visible) face(dir, [top[0], top[1], bottom[1], bottom[0]]);
    } else if (!res.info(n.name).occludes) {
      face(dir, [top[0], top[1], bottomWhenAir[1], bottomWhenAir[0]]);
    }
  };

  if (!aboveSame && !aboveOccludes) face('up', [[0, hNW, 0], [1, hNE, 0], [1, hSE, 1], [0, hSW, 1]]);
  if (shouldDraw('down')) face('down', [[0, 0, 1], [1, 0, 1], [1, 0, 0], [0, 0, 0]]);
  side('north',
    [[1, hNE, 0], [0, hNW, 0]],
    [[1, 0, 0], [0, 0, 0]],
    () => [[1, cornerHeight(wx, wz - 1, 1, 1), 0], [0, cornerHeight(wx, wz - 1, -1, 1), 0]],
  );
  side('south',
    [[0, hSW, 1], [1, hSE, 1]],
    [[0, 0, 1], [1, 0, 1]],
    () => [[0, cornerHeight(wx, wz + 1, -1, -1), 1], [1, cornerHeight(wx, wz + 1, 1, -1), 1]],
  );
  side('west',
    [[0, hNW, 0], [0, hSW, 1]],
    [[0, 0, 0], [0, 0, 1]],
    () => [[0, cornerHeight(wx - 1, wz, 1, -1), 0], [0, cornerHeight(wx - 1, wz, 1, 1), 1]],
  );
  side('east',
    [[1, hSE, 1], [1, hNE, 0]],
    [[1, 0, 1], [1, 0, 0]],
    () => [[1, cornerHeight(wx + 1, wz, -1, 1), 1], [1, cornerHeight(wx + 1, wz, -1, -1), 0]],
  );
}

/** 网格化一个 16³ section。坐标相对 section 原点。 */
export function meshSection(
  res: MesherResources, view: WorldView,
  cx: number, sy: number, cz: number,
  smoothLighting = true,
): SectionMeshes {
  const infoCache = new Map<string, BlockInfo>();
  const cachedInfo = (name: string): BlockInfo => {
    let hit = infoCache.get(name);
    if (!hit) {
      hit = res.info(name);
      infoCache.set(name, hit);
    }
    return hit;
  };
  const localRes: MesherResources = { ...res, info: cachedInfo };
  const builders: Record<RenderLayer, MeshBuilder> = {
    opaque: new MeshBuilder(),
    opaqueTiled: new MeshBuilder(true),
    cutout: new MeshBuilder(),
    translucent: new MeshBuilder(),
  };
  const greedyGrids = new Map<string, GreedyGrid>();
  const simpleCubeCache = new WeakMap<BakedQuad[], SimpleCubeDef | null>();
  const cachedSimpleCube = (quads: BakedQuad[]): SimpleCubeDef | null => {
    if (!simpleCubeCache.has(quads)) simpleCubeCache.set(quads, simpleCubeFromQuads(quads, localRes.textureHasAlpha));
    return simpleCubeCache.get(quads) ?? null;
  };
  const ox = cx * 16, oy = sy * 16, oz = cz * 16;
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const wx = ox + x, wy = oy + y, wz = oz + z;
        const state = view.getBlock(wx, wy, wz);
        if (AIR_NAMES.has(state.name)) continue;
        const bi = cachedInfo(state.name);
        const blockLayer = bi.layer === 'opaqueTiled' ? 'opaque' : bi.layer;

        const waterlogged = state.properties.waterlogged === 'true' || !!bi.waterlogged;
        if (bi.fluid) {
          emitFluid(localRes, view, builders, bi.fluid, state, x, y, z, wx, wy, wz);
          continue;
        }
        if (waterlogged) {
          const water = cachedInfo('minecraft:water').fluid;
          if (water) emitFluid(localRes, view, builders, water, { name: 'minecraft:water', properties: { level: '0' } }, x, y, z, wx, wy, wz);
        }

        const quads = localRes.baker.getQuads(state, hash3(wx, wy, wz));
        const simple = !waterlogged
          && blockLayer === 'opaque'
          && bi.occludes
          && bi.tint === 'none'
          && bi.fixedTint === undefined
          ? cachedSimpleCube(quads)
          : null;
        if (simple) {
          for (const dir of SECTION_VISIBILITY_DIRECTIONS) {
            const q = simple[dir];
            const d = DIR_VEC[dir];
            const n = view.getBlock(wx + d[0], wy + d[1], wz + d[2]);
            if (cachedInfo(n.name).occludes) continue;
            const cell = greedyCellForQuad(localRes, view, q, wx, wy, wz, smoothLighting);
            if (cell) {
              const coord = greedyCoords(dir, x, y, z);
              addGreedyCell(greedyGrids, dir, coord.slice, coord.u, coord.v, cell);
            } else {
              emitQuad(localRes, view, builders.opaque, q, x, y, z, wx, wy, wz, WHITE, smoothLighting);
            }
          }
          continue;
        }

        if (!waterlogged && bi.occludes && fullyOccluded(localRes, view, wx, wy, wz)) continue;

        for (const q of quads) {
          if (q.cullFace) {
            const d = DIR_VEC[q.cullFace];
            const n = view.getBlock(wx + d[0], wy + d[1], wz + d[2]);
            const ni = cachedInfo(n.name);
            if (ni.occludes) continue;
            if (bi.layer === 'translucent' && n.name === state.name) continue;
          }
          const tint = q.tintIndex >= 0
            ? localRes.tint(bi.tint, bi.fixedTint, view.getBiome(wx, wy, wz))
            : WHITE;
          const layer = blockLayer === 'opaque' && localRes.textureHasAlpha?.[q.texture] ? 'cutout' : blockLayer;
          emitQuad(localRes, view, builders[layer], q, x, y, z, wx, wy, wz, tint, smoothLighting);
        }
      }
    }
  }
  flushGreedyGrids(greedyGrids, builders.opaqueTiled);
  const out: SectionMeshes = {};
  for (const layer of ['opaque', 'opaqueTiled', 'cutout', 'translucent'] as RenderLayer[]) {
    if (!builders[layer].empty) out[layer] = builders[layer].build();
  }
  return out;
}

function visibilityBit(from: number, to: number): number {
  return 2 ** (from * SECTION_VISIBILITY_DIRECTIONS.length + to);
}

/**
 * Minecraft 1.8-style section visibility graph input.
 *
 * The mask stores directed connectivity between the six section boundary faces.
 * A bit at from*6+to means transparent/non-occluding cells connect those faces,
 * so traversal can continue through the section from `from` to `to`.
 */
export function sectionVisibilityMask(
  res: Pick<MesherResources, 'info'>,
  view: WorldView,
  cx: number,
  sy: number,
  cz: number,
): number {
  const ox = cx * 16;
  const oy = sy * 16;
  const oz = cz * 16;
  const total = 16 * 16 * 16;
  const passable = new Uint8Array(total);
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let passableCount = 0;

  const idxOf = (x: number, y: number, z: number) => (y << 8) | (z << 4) | x;
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const i = idxOf(x, y, z);
        if (!res.info(view.getBlock(ox + x, oy + y, oz + z).name).occludes) {
          passable[i] = 1;
          passableCount++;
        }
      }
    }
  }

  if (passableCount === 0) return 0;
  if (passableCount === total) {
    let all = 0;
    for (let from = 0; from < 6; from++) {
      for (let to = 0; to < 6; to++) {
        if (from !== to) all += visibilityBit(from, to);
      }
    }
    return all;
  }

  const faceBitsOf = (x: number, y: number, z: number): number => {
    let bits = 0;
    if (y === 0) bits |= 1 << 0;
    if (y === 15) bits |= 1 << 1;
    if (z === 0) bits |= 1 << 2;
    if (z === 15) bits |= 1 << 3;
    if (x === 0) bits |= 1 << 4;
    if (x === 15) bits |= 1 << 5;
    return bits;
  };

  let mask = 0;
  for (let start = 0; start < total; start++) {
    if (!passable[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    let faces = 0;
    visited[start] = 1;
    queue[tail++] = start;

    while (head < tail) {
      const i = queue[head++];
      const y = i >> 8;
      const z = (i >> 4) & 15;
      const x = i & 15;
      faces |= faceBitsOf(x, y, z);

      const push = (nx: number, ny: number, nz: number) => {
        const ni = idxOf(nx, ny, nz);
        if (!passable[ni] || visited[ni]) return;
        visited[ni] = 1;
        queue[tail++] = ni;
      };

      if (x > 0) push(x - 1, y, z);
      if (x < 15) push(x + 1, y, z);
      if (y > 0) push(x, y - 1, z);
      if (y < 15) push(x, y + 1, z);
      if (z > 0) push(x, y, z - 1);
      if (z < 15) push(x, y, z + 1);
    }

    for (let from = 0; from < 6; from++) {
      if (!(faces & (1 << from))) continue;
      for (let to = 0; to < 6; to++) {
        if (from !== to && (faces & (1 << to))) mask += visibilityBit(from, to);
      }
    }
  }
  return mask;
}
