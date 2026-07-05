import { ModelBaker, BakedQuad, MISSING_TEXTURE } from './model.js';
import { AIR, AIR_NAMES, ChunkColumn } from './world.js';
import {
  AtlasIndex, BlockInfo, BlockStateRef, Direction, DIR_VEC, MeshBuffers, RenderLayer,
  SectionMeshes, TintType,
} from './types.js';
import type { Rgb } from './colors.js';

export interface WorldView {
  getBlock(x: number, y: number, z: number): BlockStateRef;
  getBiome(x: number, y: number, z: number): string;
  getSkyLight(x: number, y: number, z: number): number;
  getBlockLight(x: number, y: number, z: number): number;
}

/** 3x3 邻域，供跨区块面剔除 / AO / 平滑光照。 */
export class ChunkNeighborhood implements WorldView {
  private grid: (ChunkColumn | null)[] = new Array(9).fill(null);
  constructor(readonly baseX: number, readonly baseZ: number) {}
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
}

const SHADE: Record<Direction, number> = { up: 1, down: 0.5, north: 0.8, south: 0.8, west: 0.6, east: 0.6 };
const AO_FACTOR = [0.4, 0.6, 0.8, 1.0];
// 每个面的两个切向轴（坐标分量下标）
const TANGENTS: Record<Direction, [number, number]> = {
  up: [0, 2], down: [0, 2], north: [0, 1], south: [0, 1], west: [1, 2], east: [1, 2],
};
const WHITE: Rgb = [1, 1, 1];

/** 原版风格的坐标散列，用于随机变体选择。 */
export function hash3(x: number, y: number, z: number): number {
  let h = (Math.imul(x, 3129871) ^ Math.imul(z, 116129781) ^ y) | 0;
  h = (Math.imul(h, Math.imul(h, 42317861)) + Math.imul(h, 11)) | 0;
  return h >>> 16;
}

class MeshBuilder {
  pos: number[] = []; uv: number[] = []; col: number[] = []; light: number[] = []; idx: number[] = [];
  verts = 0;
  get empty() { return this.verts === 0; }
  vertex(x: number, y: number, z: number, u: number, v: number, r: number, g: number, b: number, sky: number, block: number) {
    this.pos.push(x, y, z); this.uv.push(u, v); this.col.push(r, g, b); this.light.push(sky, block);
    this.verts++;
  }
  quadIndices() {
    const b = this.verts - 4;
    this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  build(): MeshBuffers {
    return {
      positions: new Float32Array(this.pos), uvs: new Float32Array(this.uv),
      colors: new Float32Array(this.col), lights: new Float32Array(this.light),
      indices: new Uint32Array(this.idx),
    };
  }
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
  }
  for (let i = 0; i < 4; i++) {
    let sky = flatSky, block = flatBlock, ao = 1;
    if (smooth && outside && q.ao) {
      const s = smoothVertexLight(res, view, q, i, bx, by, bz);
      sky = s.sky; block = s.block; ao = s.ao;
    }
    const m = shade * ao;
    builder.vertex(
      lx + q.positions[i * 3], ly + q.positions[i * 3 + 1], lz + q.positions[i * 3 + 2],
      rect.u0 + (q.uvs[i * 2] / 16) * (rect.u1 - rect.u0),
      rect.v0 + (q.uvs[i * 2 + 1] / 16) * (rect.v1 - rect.v0),
      tint[0] * m, tint[1] * m, tint[2] * m, sky, block,
    );
  }
  builder.quadIndices();
}

function isSameFluid(res: MesherResources, texture: string, state: BlockStateRef): boolean {
  const bi = res.info(state.name);
  if (bi.fluid?.texture === texture) return true;
  return (state.properties.waterlogged === 'true' || !!bi.waterlogged) && texture.includes('water');
}

function emitFluid(
  res: MesherResources, view: WorldView, builders: Record<RenderLayer, MeshBuilder>,
  fluid: NonNullable<BlockInfo['fluid']>,
  lx: number, ly: number, lz: number, wx: number, wy: number, wz: number,
) {
  const builder = builders[fluid.layer ?? 'translucent'];
  const rect = res.atlas[fluid.texture] ?? res.atlas[MISSING_TEXTURE];
  const tint = res.tint(fluid.tint, undefined, view.getBiome(wx, wy, wz));
  const aboveSame = isSameFluid(res, fluid.texture, view.getBlock(wx, wy + 1, wz));
  const h = aboveSame ? 1 : 14 / 16;
  const sky = view.getSkyLight(wx, wy, wz) / 15;
  const block = view.getBlockLight(wx, wy, wz) / 15;

  // 直接内联各面（uv 简化为整面）
  const face = (dir: Direction, verts: [number, number, number][]) => {
    const shade = SHADE[dir];
    const uvs: [number, number][] = [[rect.u0, rect.v0], [rect.u1, rect.v0], [rect.u1, rect.v1], [rect.u0, rect.v1]];
    verts.forEach((v, i) => builder.vertex(
      lx + v[0], ly + v[1], lz + v[2], uvs[i][0], uvs[i][1],
      tint[0] * shade, tint[1] * shade, tint[2] * shade, sky, block,
    ));
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
  if (!aboveSame) face('up', [[0, h, 0], [1, h, 0], [1, h, 1], [0, h, 1]]);
  if (shouldDraw('down')) face('down', [[0, 0, 1], [1, 0, 1], [1, 0, 0], [0, 0, 0]]);
  if (shouldDraw('north')) face('north', [[1, h, 0], [0, h, 0], [0, 0, 0], [1, 0, 0]]);
  if (shouldDraw('south')) face('south', [[0, h, 1], [1, h, 1], [1, 0, 1], [0, 0, 1]]);
  if (shouldDraw('west')) face('west', [[0, h, 0], [0, h, 1], [0, 0, 1], [0, 0, 0]]);
  if (shouldDraw('east')) face('east', [[1, h, 1], [1, h, 0], [1, 0, 0], [1, 0, 1]]);
}

/** 网格化一个 16³ section。坐标相对 section 原点。 */
export function meshSection(
  res: MesherResources, view: WorldView,
  cx: number, sy: number, cz: number,
  smoothLighting = true,
): SectionMeshes {
  const builders: Record<RenderLayer, MeshBuilder> = {
    opaque: new MeshBuilder(), cutout: new MeshBuilder(), translucent: new MeshBuilder(),
  };
  const ox = cx * 16, oy = sy * 16, oz = cz * 16;
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const wx = ox + x, wy = oy + y, wz = oz + z;
        const state = view.getBlock(wx, wy, wz);
        if (AIR_NAMES.has(state.name)) continue;
        const bi = res.info(state.name);

        const waterlogged = state.properties.waterlogged === 'true' || !!bi.waterlogged;
        if (bi.fluid) {
          emitFluid(res, view, builders, bi.fluid, x, y, z, wx, wy, wz);
          continue;
        }
        if (waterlogged) {
          const water = res.info('minecraft:water').fluid;
          if (water) emitFluid(res, view, builders, water, x, y, z, wx, wy, wz);
        }

        const quads = res.baker.getQuads(state, hash3(wx, wy, wz));
        for (const q of quads) {
          if (q.cullFace) {
            const d = DIR_VEC[q.cullFace];
            const n = view.getBlock(wx + d[0], wy + d[1], wz + d[2]);
            const ni = res.info(n.name);
            if (ni.occludes) continue;
            if (bi.layer !== 'opaque' && n.name === state.name) continue;
          }
          const tint = q.tintIndex >= 0
            ? res.tint(bi.tint, bi.fixedTint, view.getBiome(wx, wy, wz))
            : WHITE;
          emitQuad(res, view, builders[bi.layer], q, x, y, z, wx, wy, wz, tint, smoothLighting);
        }
      }
    }
  }
  const out: SectionMeshes = {};
  for (const layer of ['opaque', 'cutout', 'translucent'] as RenderLayer[]) {
    if (!builders[layer].empty) out[layer] = builders[layer].build();
  }
  return out;
}