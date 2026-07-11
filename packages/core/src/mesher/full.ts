import { ModelBaker, BakedQuad, MISSING_TEXTURE } from '../model.js';
import { AIR, AIR_NAMES, ChunkColumn } from '../world.js';
import {
  AtlasIndex, AtlasRect, BlockInfo, BlockStateRef, Direction, DIR_VEC, MeshBuffers, RenderLayer,
  SectionMeshes, TextureAlphaMap, TintType,
} from '../types.js';
import type { Rgb } from '../colors.js';
import { Float32Writer, Uint16Writer, Uint32Writer } from '../utils.js';

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
  columnAtWorld(x: number, z: number): ChunkColumn | null {
    return this.colAt(x, z);
  }
  getBlock(x: number, y: number, z: number) { return this.colAt(x, z)?.getBlock(x & 15, y, z & 15) ?? AIR; }
  getBiome(x: number, y: number, z: number) { return this.colAt(x, z)?.getBiome(x & 15, y, z & 15) ?? 'minecraft:plains'; }
  getSkyLight(x: number, y: number, z: number) { return this.colAt(x, z)?.getSkyLight(x & 15, y, z & 15) ?? 15; }
  getBlockLight(x: number, y: number, z: number) { return this.colAt(x, z)?.getBlockLight(x & 15, y, z & 15) ?? 0; }
}

export interface MesherResources {
  baker: ModelBaker;
  info(name: string): BlockInfo;
  tint(type: TintType, fixed: number | undefined, biome: string, state?: BlockStateRef): Rgb;
  atlas: AtlasIndex;
  textureHasAlpha?: TextureAlphaMap;
  /** Stable ids prepared by the viewer for animated atlas sprites. */
  textureAnimationIds?: Record<string, number>;
}

/** A resolved, resource-declared model placement. The worker intentionally
 * supplies these instead of naming chests/signs/entities in meshing code. */
export interface RenderModelInstance {
  model: string;
  x: number;
  y: number;
  z: number;
  layer: 'opaque' | 'cutout' | 'translucent';
  offset?: [number, number, number];
  scale?: [number, number, number];
  rotationY?: number;
  /** Optional resource-declared replacement for every texture in this
   * instance. This lets one geometry definition serve all sign woods and
   * chest variants without baking game ids into the mesher. */
  texture?: string;
}

const SHADE: Record<Direction, number> = { up: 1, down: 0.5, north: 0.8, south: 0.8, west: 0.6, east: 0.6 };
const OCCLUSION_DIRECTIONS: Direction[] = ['down', 'up', 'north', 'south', 'west', 'east'];
export const SECTION_VISIBILITY_DIRECTIONS: Direction[] = ['down', 'up', 'north', 'south', 'west', 'east'];
const DIRECTION_INDEX: Record<Direction, number> = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 };
const ALL_DIRECTIONS_OCCLUDED = (1 << SECTION_VISIBILITY_DIRECTIONS.length) - 1;
const SECTION_VISIBILITY_ALL = (() => {
  let mask = 0;
  for (let from = 0; from < 6; from++) {
    for (let to = 0; to < 6; to++) {
      if (from !== to) mask += 2 ** (from * 6 + to);
    }
  }
  return mask;
})();
const AO_FACTOR = [0.4, 0.6, 0.8, 1.0];
// 每个面的两个切向轴（坐标分量下标）
const TANGENTS: Record<Direction, [number, number]> = {
  up: [0, 2], down: [0, 2], north: [0, 1], south: [0, 1], west: [1, 2], east: [1, 2],
};
const WHITE: Rgb = [1, 1, 1];
const UV_EPS = 1e-4;
const HEIGHT_EPS = 1e-3;
const GEOMETRY_EPS = 1e-4;
const SECTION_POSITION_SCALE = 18;
const SECTION_POSITION_OFFSET = -1;
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
  key: number;
  rect: AtlasRect;
  r: number;
  sky: number;
  block: number;
}

interface GreedyGrid {
  dir: Direction;
  slice: number;
  cells: (GreedyCell | null)[];
}

export interface MeshSectionResult {
  layers: SectionMeshes;
  visibility: number;
}

interface BlockStateMeshMeta {
  bi: BlockInfo;
  blockLayer: RenderLayer;
  waterlogged: boolean;
  fullOccluder: boolean;
  simpleEligible: boolean;
}

const SIMPLE_CUBE_CACHE = new WeakMap<BakedQuad[], {
  alpha: TextureAlphaMap | undefined;
  animations: Record<string, number> | undefined;
  value: SimpleCubeDef | null;
}>();

function cachedSimpleCube(
  quads: BakedQuad[], textureHasAlpha?: TextureAlphaMap, textureAnimationIds?: Record<string, number>,
): SimpleCubeDef | null {
  const hit = SIMPLE_CUBE_CACHE.get(quads);
  if (hit && hit.alpha === textureHasAlpha && hit.animations === textureAnimationIds) return hit.value;
  const value = simpleCubeFromQuads(quads, textureHasAlpha, textureAnimationIds);
  SIMPLE_CUBE_CACHE.set(quads, { alpha: textureHasAlpha, animations: textureAnimationIds, value });
  return value;
}

class SectionViewCache implements WorldView {
  private readonly states = new Array<BlockStateRef>(18 * 18 * 18);
  private readonly occlusion = new Uint8Array(18 * 18 * 18);
  private readonly sky = new Uint8Array(18 * 18 * 18);
  private readonly block = new Uint8Array(18 * 18 * 18);
  private readonly biomes = new Array<string | undefined>(18 * 18 * 18);
  private readonly ox: number;
  private readonly oy: number;
  private readonly oz: number;

  constructor(
    private readonly res: MesherResources,
    private readonly base: WorldView,
    cx: number,
    sy: number,
    cz: number,
  ) {
    const neighborhood = base instanceof ChunkNeighborhood ? base : null;
    const occlusionByState = new WeakMap<BlockStateRef, number>();
    const occlusionOf = (state: BlockStateRef): number => {
      const hit = occlusionByState.get(state);
      if (hit !== undefined) return hit;
      // Only a genuine opaque, full cube may seal light/visibility or cull a
      // neighbour's cullface. It may still have extra decorative quads: grass
      // blocks add their tinted side overlay, for example. Minecraft-data's
      // bounding-box flag alone marks a number of partial blocks as full (for
      // example sculk shriekers), which previously made visible sides vanish.
      const value = res.info(state.name).occludes
        && opaqueFullCubeFromQuads(res.baker.getQuads(state, 0), res.textureHasAlpha)
        ? 1 : 0;
      occlusionByState.set(state, value);
      return value;
    };
    this.ox = cx * 16;
    this.oy = sy * 16;
    this.oz = cz * 16;
    const centerCol = neighborhood?.columnAtWorld(this.ox, this.oz) ?? null;
    const centerSection = centerCol?.sections.get(sy) ?? null;
    for (let y = 0; y < 18; y++) {
      for (let z = 0; z < 18; z++) {
        for (let x = 0; x < 18; x++) {
          const i = this.idx(x, y, z);
          const wx = this.ox + x - 1;
          const wy = this.oy + y - 1;
          const wz = this.oz + z - 1;
          let state: BlockStateRef;
          if (centerCol && centerSection && x > 0 && x < 17 && y > 0 && y < 17 && z > 0 && z < 17) {
            const lx = x - 1;
            const ly = y - 1;
            const lz = z - 1;
            const localIndex = (ly << 8) | (lz << 4) | lx;
            state = centerSection.block(lx, ly, lz);
            this.sky[i] = centerSection.skyLight ? centerSection.skyLight[localIndex] : centerCol.getSkyLight(lx, wy, lz);
            this.block[i] = centerSection.blockLight ? centerSection.blockLight[localIndex] : 0;
          } else if (neighborhood) {
            const col = neighborhood.columnAtWorld(wx, wz);
            if (col) {
              state = col.getBlock(wx & 15, wy, wz & 15);
              this.sky[i] = col.getSkyLight(wx & 15, wy, wz & 15);
              this.block[i] = col.getBlockLight(wx & 15, wy, wz & 15);
            } else {
              state = AIR;
              this.sky[i] = 15;
              this.block[i] = 0;
            }
          } else {
            state = base.getBlock(wx, wy, wz);
            this.sky[i] = base.getSkyLight(wx, wy, wz);
            this.block[i] = base.getBlockLight(wx, wy, wz);
          }
          this.states[i] = state;
          this.occlusion[i] = occlusionOf(state);
        }
      }
    }
  }

  private idx(x: number, y: number, z: number): number {
    return (y * 18 + z) * 18 + x;
  }

  private localIndex(x: number, y: number, z: number): number {
    return this.idx(x - this.ox + 1, y - this.oy + 1, z - this.oz + 1);
  }

  private contains(x: number, y: number, z: number): boolean {
    return x >= this.ox - 1 && x <= this.ox + 16
      && y >= this.oy - 1 && y <= this.oy + 16
      && z >= this.oz - 1 && z <= this.oz + 16;
  }

  blockLocal(x: number, y: number, z: number): BlockStateRef {
    return this.states[this.idx(x + 1, y + 1, z + 1)] ?? AIR;
  }

  occludesLocal(x: number, y: number, z: number): boolean {
    return this.occlusion[this.idx(x + 1, y + 1, z + 1)] > 0;
  }

  fullyOccludedLocal(x: number, y: number, z: number): boolean {
    return this.occludesLocal(x - 1, y, z)
      && this.occludesLocal(x + 1, y, z)
      && this.occludesLocal(x, y - 1, z)
      && this.occludesLocal(x, y + 1, z)
      && this.occludesLocal(x, y, z - 1)
      && this.occludesLocal(x, y, z + 1);
  }

  getBlock(x: number, y: number, z: number): BlockStateRef {
    return this.contains(x, y, z) ? this.states[this.localIndex(x, y, z)] ?? AIR : this.base.getBlock(x, y, z);
  }

  getBiome(x: number, y: number, z: number): string {
    if (!this.contains(x, y, z)) return this.base.getBiome(x, y, z);
    const i = this.localIndex(x, y, z);
    let biome = this.biomes[i];
    if (!biome) {
      biome = this.base.getBiome(x, y, z);
      this.biomes[i] = biome;
    }
    return biome;
  }

  getSkyLight(x: number, y: number, z: number): number {
    return this.contains(x, y, z) ? this.sky[this.localIndex(x, y, z)] : this.base.getSkyLight(x, y, z);
  }

  getBlockLight(x: number, y: number, z: number): number {
    return this.contains(x, y, z) ? this.block[this.localIndex(x, y, z)] : this.base.getBlockLight(x, y, z);
  }

  occludesAt(x: number, y: number, z: number): boolean {
    return this.contains(x, y, z)
      ? this.occlusion[this.localIndex(x, y, z)] > 0
      : this.res.info(this.base.getBlock(x, y, z).name).occludes;
  }

  isSealedOccluderSection(): boolean {
    for (let y = 1; y <= 16; y++) {
      for (let z = 1; z <= 16; z++) {
        for (let x = 1; x <= 16; x++) {
          if (!this.occlusion[this.idx(x, y, z)]) return false;
        }
      }
    }
    for (let y = 1; y <= 16; y++) {
      for (let z = 1; z <= 16; z++) {
        if (!this.occlusion[this.idx(0, y, z)] || !this.occlusion[this.idx(17, y, z)]) return false;
      }
      for (let x = 1; x <= 16; x++) {
        if (!this.occlusion[this.idx(x, y, 0)] || !this.occlusion[this.idx(x, y, 17)]) return false;
      }
    }
    for (let z = 1; z <= 16; z++) {
      for (let x = 1; x <= 16; x++) {
        if (!this.occlusion[this.idx(x, 0, z)] || !this.occlusion[this.idx(x, 17, z)]) return false;
      }
    }
    return true;
  }

  visibilityMask(): number {
    const total = 16 * 16 * 16;
    const visited = new Uint8Array(total);
    const queue = new Int32Array(total);
    const idxOf = (x: number, y: number, z: number) => (y << 8) | (z << 4) | x;
    let passableCount = 0;
    for (let y = 0; y < 16; y++) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          if (!this.occlusion[this.idx(x + 1, y + 1, z + 1)]) passableCount++;
        }
      }
    }
    if (passableCount === 0) return 0;
    if (passableCount === total) return SECTION_VISIBILITY_ALL;

    let mask = 0;
    for (let start = 0; start < total; start++) {
      const sy = start >> 8;
      const sz = (start >> 4) & 15;
      const sx = start & 15;
      if (visited[start] || this.occlusion[this.idx(sx + 1, sy + 1, sz + 1)]) continue;
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
        if (y === 0) faces |= 1 << 0;
        if (y === 15) faces |= 1 << 1;
        if (z === 0) faces |= 1 << 2;
        if (z === 15) faces |= 1 << 3;
        if (x === 0) faces |= 1 << 4;
        if (x === 15) faces |= 1 << 5;

        const push = (nx: number, ny: number, nz: number) => {
          const ni = idxOf(nx, ny, nz);
          if (visited[ni] || this.occlusion[this.idx(nx + 1, ny + 1, nz + 1)]) return;
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
}

/** 原版风格的坐标散列，用于随机变体选择。 */
export function hash3(x: number, y: number, z: number): number {
  let h = (Math.imul(x, 3129871) ^ Math.imul(z, 116129781) ^ y) | 0;
  h = (Math.imul(h, Math.imul(h, 42317861)) + Math.imul(h, 11)) | 0;
  return h >>> 16;
}

function packNormalizedUint8(values: Float32Array): Uint8Array {
  const out = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Math.round(Math.min(1, Math.max(0, values[i])) * 255);
  return out;
}

function packNormalizedUint16(values: Float32Array): Uint16Array {
  const out = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Math.round(Math.min(1, Math.max(0, values[i])) * 65535);
  return out;
}

function packUint16(values: Float32Array): Uint16Array {
  const out = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Math.round(Math.min(65535, Math.max(0, values[i])));
  return out;
}

function packSectionPositions(values: Float32Array): Uint16Array {
  const out = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) {
    out[i] = Math.round(Math.min(1, Math.max(0, (values[i] - SECTION_POSITION_OFFSET) / SECTION_POSITION_SCALE)) * 65535);
  }
  return out;
}

function packIndices(values: Uint32Array, vertexCount: number): Uint16Array | Uint32Array {
  if (vertexCount > 65535) return values;
  const out = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = values[i];
  return out;
}

class MeshBuilder {
  pos = new Float32Writer(4096 * 3);
  uv = new Float32Writer(4096 * 2);
  atlas: Float32Writer | null;
  col = new Float32Writer(4096 * 3);
  light = new Float32Writer(4096 * 2);
  animation: Uint16Writer | null = null;
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
    animationId = 0,
  ) {
    this.pos.push3(x, y, z);
    this.uv.push2(u, v);
    if (this.atlas) {
      const rect = atlasRect ?? { u0: 0, v0: 0, u1: 0, v1: 0 };
      this.atlas.push4(rect.u0, rect.v0, rect.u1, rect.v1);
    }
    this.col.push3(r, g, b);
    this.light.push2(sky, block);
    if (animationId > 0 && !this.animation) {
      this.animation = new Uint16Writer(Math.max(4096, this.verts + 1));
      for (let i = 0; i < this.verts; i++) this.animation.push1(0);
    }
    if (this.animation) this.animation.push1(animationId);
    this.verts++;
  }
  quadIndices() {
    const b = this.verts - 4;
    this.idx.push6(b, b + 2, b + 1, b, b + 3, b + 2);
  }
  build(): MeshBuffers {
    const positions = this.pos.view();
    const uvs = this.uv.view();
    const atlasRects = this.atlas?.view();
    const colors = this.col.view();
    const lights = this.light.view();
    const animations = this.animation?.view();
    const indices = this.idx.view();
    return {
      positions: packSectionPositions(positions),
      uvs: this.atlas ? packUint16(uvs) : packNormalizedUint16(uvs),
      atlasRects: atlasRects ? packNormalizedUint16(atlasRects) : undefined,
      colors: packNormalizedUint8(colors),
      lights: packNormalizedUint8(lights),
      animations,
      indices: packIndices(indices, this.verts),
    };
  }
}

type MeshBuilderStore = Partial<Record<RenderLayer, MeshBuilder>>;

function builderFor(builders: MeshBuilderStore, layer: RenderLayer): MeshBuilder {
  return builders[layer] ??= new MeshBuilder(layer === 'opaqueTiled');
}

function atlasUv(rect: AtlasRect, u: number, v: number, uvScale: [number, number] = [16, 16]): [number, number] {
  const width = Math.max(UV_EPS * 2, uvScale[0]);
  const height = Math.max(UV_EPS * 2, uvScale[1]);
  const tu = Math.min(width - UV_EPS, Math.max(UV_EPS, u));
  const tv = Math.min(height - UV_EPS, Math.max(UV_EPS, v));
  return [
    rect.u0 + (tu / width) * (rect.u1 - rect.u0),
    rect.v0 + (tv / height) * (rect.v1 - rect.v0),
  ];
}

function blockOccludes(res: MesherResources, view: WorldView, x: number, y: number, z: number): boolean {
  return view instanceof SectionViewCache
    ? view.occludesAt(x, y, z)
    : res.info(view.getBlock(x, y, z).name).occludes;
}

function smoothVertexLightPacked(
  res: MesherResources, view: WorldView, q: BakedQuad, vi: number,
  bx: number, by: number, bz: number,
): number {
  const [a1, a2] = TANGENTS[q.face];
  const c1 = q.positions[vi * 3 + a1] > 0.5 ? 1 : -1;
  const c2 = q.positions[vi * 3 + a2] > 0.5 ? 1 : -1;
  const x1 = bx + (a1 === 0 ? c1 : 0);
  const y1 = by + (a1 === 1 ? c1 : 0);
  const z1 = bz + (a1 === 2 ? c1 : 0);
  const x2 = bx + (a2 === 0 ? c2 : 0);
  const y2 = by + (a2 === 1 ? c2 : 0);
  const z2 = bz + (a2 === 2 ? c2 : 0);
  const x3 = x1 + (a2 === 0 ? c2 : 0);
  const y3 = y1 + (a2 === 1 ? c2 : 0);
  const z3 = z1 + (a2 === 2 ? c2 : 0);
  const occ1 = blockOccludes(res, view, x1, y1, z1);
  const occ2 = blockOccludes(res, view, x2, y2, z2);
  const occ3 = blockOccludes(res, view, x3, y3, z3);
  let sky = 0, block = 0, count = 0;
  sky += view.getSkyLight(bx, by, bz);
  block += view.getBlockLight(bx, by, bz);
  count++;
  if (!occ1) {
    sky += view.getSkyLight(x1, y1, z1);
    block += view.getBlockLight(x1, y1, z1);
    count++;
  }
  if (!occ2) {
    sky += view.getSkyLight(x2, y2, z2);
    block += view.getBlockLight(x2, y2, z2);
    count++;
  }
  if (!occ3 && !(occ1 && occ2)) {
    sky += view.getSkyLight(x3, y3, z3);
    block += view.getBlockLight(x3, y3, z3);
    count++;
  }
  const s1 = occ1 ? 1 : 0, s2 = occ2 ? 1 : 0, co = occ3 ? 1 : 0;
  const aoLevel = s1 && s2 ? 0 : 3 - (s1 + s2 + co);
  const skyQ = quantByte(sky / Math.max(count, 1) / 15);
  const blockQ = quantByte(block / Math.max(count, 1) / 15);
  return skyQ | (blockQ << 8) | (aoLevel << 16);
}

function emitQuad(
  res: MesherResources, view: WorldView, builder: MeshBuilder, q: BakedQuad,
  lx: number, ly: number, lz: number, wx: number, wy: number, wz: number,
  tint: Rgb, smooth: boolean,
) {
  const rect = res.atlas[q.texture] ?? res.atlas[MISSING_TEXTURE];
  const shade = q.shade ? SHADE[q.face] : 1;
  // `cullface` controls neighbour face removal only. It is deliberately
  // omitted on quite a few exterior partial-model faces (notably stairs) so
  // that they are not removed by a block beside them. Those faces still need
  // their real outside AO/light sample. Treat a quad as exterior when its
  // plane lies on the matching unit-cube boundary.
  const lightFace = q.cullFace ?? exteriorFace(q);
  const d = DIR_VEC[lightFace ?? q.face];
  const outside = lightFace !== null;
  const bx = outside ? wx + d[0] : wx;
  const by = outside ? wy + d[1] : wy;
  const bz = outside ? wz + d[2] : wz;
  let flatSky = 0, flatBlock = 0;
  // A model can explicitly disable ambient occlusion (hoppers do). That is a
  // request for ordinary flat face lighting, not zero light; leaving it out
  // made every exterior hopper quad nearly black.
  if (!smooth || !outside || !q.ao) {
    flatSky = view.getSkyLight(bx, by, bz) / 15;
    flatBlock = view.getBlockLight(bx, by, bz) / 15;
    if (!outside) {
      // Internal/non-cullface model faces (hopper bowls, door planes, etc.)
      // are often visible from a direction unrelated to their mathematical
      // normal. Sampling only that normal used the solid block below for many
      // of them, turning otherwise sunlit geometry pure black.
      for (const direction of OCCLUSION_DIRECTIONS) {
        const n = DIR_VEC[direction];
        flatSky = Math.max(flatSky, view.getSkyLight(wx + n[0], wy + n[1], wz + n[2]) / 15);
        flatBlock = Math.max(flatBlock, view.getBlockLight(wx + n[0], wy + n[1], wz + n[2]) / 15);
      }
    }
  }
  for (let i = 0; i < 4; i++) {
    let sky = flatSky, block = flatBlock, ao = 1;
    if (smooth && outside && q.ao) {
      const s = smoothVertexLightPacked(res, view, q, i, bx, by, bz);
      sky = (s & 255) / 255;
      block = ((s >> 8) & 255) / 255;
      ao = AO_FACTOR[(s >> 16) & 3];
    }
    const m = shade * ao;
    const [u, v] = atlasUv(rect, q.uvs[i * 2], q.uvs[i * 2 + 1], q.uvScale);
    builder.vertex(
      lx + q.positions[i * 3], ly + q.positions[i * 3 + 1], lz + q.positions[i * 3 + 2],
      u, v,
      tint[0] * m, tint[1] * m, tint[2] * m, sky, block,
      undefined, res.textureAnimationIds?.[q.texture] ?? 0,
    );
  }
  builder.quadIndices();
}

function specialLayer(layer: RenderModelInstance['layer']): RenderLayer {
  if (layer === 'translucent') return 'specialTranslucent';
  return layer === 'cutout' ? 'specialCutout' : 'specialOpaque';
}

function transformedRenderQuad(q: BakedQuad, instance: RenderModelInstance): BakedQuad {
  const scale = instance.scale ?? [1, 1, 1];
  const offset = instance.offset ?? [0, 0, 0];
  const radians = ((instance.rotationY ?? 0) * Math.PI) / 180;
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  const positions = new Float32Array(q.positions.length);
  for (let i = 0; i < 4; i++) {
    const x = q.positions[i * 3] - 0.5;
    const z = q.positions[i * 3 + 2] - 0.5;
    // Match ModelBaker's 90° rotation convention (`x' = 1-z, z' = x`),
    // while allowing the 22.5° increments used by standing signs.
    positions[i * 3] = (0.5 + x * cos - z * sin) * scale[0] + offset[0];
    positions[i * 3 + 1] = q.positions[i * 3 + 1] * scale[1] + offset[1];
    positions[i * 3 + 2] = (0.5 + x * sin + z * cos) * scale[2] + offset[2];
  }
  // These models are independent render objects. Their internal faces still
  // use the model's geometry, but block-neighbour culling must never remove a
  // chest/sign/entity face.
  return {
    ...q,
    positions,
    texture: instance.texture ?? q.texture,
    face: rotatedFaceY(q.face, sin, cos),
    cullFace: null,
  };
}

function rotatedFaceY(face: Direction, sin: number, cos: number): Direction {
  if (face === 'up' || face === 'down') return face;
  const [x, , z] = DIR_VEC[face];
  const rx = x * cos - z * sin;
  const rz = x * sin + z * cos;
  if (Math.abs(rx) >= Math.abs(rz)) return rx >= 0 ? 'east' : 'west';
  return rz >= 0 ? 'south' : 'north';
}

function exteriorFace(q: BakedQuad): Direction | null {
  const axis = q.face === 'up' || q.face === 'down' ? 1
    : q.face === 'east' || q.face === 'west' ? 0
      : 2;
  const boundary = q.face === 'up' || q.face === 'east' || q.face === 'south' ? 1 : 0;
  for (let i = 0; i < 4; i++) {
    if (Math.abs(q.positions[i * 3 + axis] - boundary) > GEOMETRY_EPS) return null;
  }
  return q.face;
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
    && q.uvScale[0] === 16
    && q.uvScale[1] === 16
    && arrayMatches(q.positions, FULL_FACE_POSITIONS[dir])
    && arrayMatches(q.uvs, FULL_FACE_UVS);
}

/** A full cube can contain extra visual quads (such as the grass overlay),
 * while the greedy path below intentionally accepts only the exact six-face
 * case. Keep those notions separate so decoration never disables culling. */
function opaqueFullCubeFromQuads(
  quads: BakedQuad[], textureHasAlpha?: TextureAlphaMap,
): boolean {
  let mask = 0;
  for (const q of quads) {
    // Tint affects colour only; a biome-tinted full face still occludes.
    if (q.face !== q.cullFace
      || q.uvScale[0] !== 16
      || q.uvScale[1] !== 16
      || !arrayMatches(q.positions, FULL_FACE_POSITIONS[q.face])
      || !arrayMatches(q.uvs, FULL_FACE_UVS)) continue;
    // Animation changes a sprite frame, not whether its face is solid. Such a
    // cube must still cull its neighbours (sculk is a notable example).
    if (textureHasAlpha?.[q.texture]) continue;
    mask |= 1 << DIRECTION_INDEX[q.face];
  }
  return mask === ALL_DIRECTIONS_OCCLUDED;
}

const OPPOSITE_DIRECTION: Record<Direction, Direction> = {
  down: 'up', up: 'down', north: 'south', south: 'north', west: 'east', east: 'west',
};

function faceBounds(q: BakedQuad, dir: Direction): [number, number, number, number] {
  const [a1, a2] = TANGENTS[dir];
  let min1 = Infinity, max1 = -Infinity, min2 = Infinity, max2 = -Infinity;
  for (let i = 0; i < 4; i++) {
    const v1 = q.positions[i * 3 + a1];
    const v2 = q.positions[i * 3 + a2];
    min1 = Math.min(min1, v1); max1 = Math.max(max1, v1);
    min2 = Math.min(min2, v2); max2 = Math.max(max2, v2);
  }
  return [min1, max1, min2, max2];
}

function faceCovers(candidate: BakedQuad, source: BakedQuad, sourceDirection: Direction): boolean {
  const [sMin1, sMax1, sMin2, sMax2] = faceBounds(source, sourceDirection);
  const [nMin1, nMax1, nMin2, nMax2] = faceBounds(candidate, sourceDirection);
  return nMin1 <= sMin1 + GEOMETRY_EPS && nMax1 >= sMax1 - GEOMETRY_EPS
    && nMin2 <= sMin2 + GEOMETRY_EPS && nMax2 >= sMax2 - GEOMETRY_EPS;
}

function simpleCubeFromQuads(
  quads: BakedQuad[], textureHasAlpha?: TextureAlphaMap, textureAnimationIds?: Record<string, number>,
): SimpleCubeDef | null {
  if (quads.length !== SECTION_VISIBILITY_DIRECTIONS.length) return null;
  const faces: Partial<SimpleCubeDef> = {};
  for (const q of quads) {
    if (!isDefaultCubeFace(q, q.face)) return null;
    if (textureHasAlpha?.[q.texture] || textureAnimationIds?.[q.texture]) return null;
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
  res: MesherResources, view: WorldView, q: BakedQuad, textureKey: number,
  wx: number, wy: number, wz: number, smooth: boolean,
): GreedyCell | null {
  const rect = res.atlas[q.texture] ?? res.atlas[MISSING_TEXTURE];
  if (!rect) return null;
  const shade = q.shade ? SHADE[q.face] : 1;
  const d = DIR_VEC[q.face];
  const bx = wx + d[0], by = wy + d[1], bz = wz + d[2];
  const flatSky = view.getSkyLight(bx, by, bz) / 15;
  const flatBlock = view.getBlockLight(bx, by, bz) / 15;
  let key = 0;
  let out: GreedyCell | null = null;
  for (let i = 0; i < 4; i++) {
    let sky = flatSky, block = flatBlock, ao = 1;
    if (smooth && q.ao) {
      const s = smoothVertexLightPacked(res, view, q, i, bx, by, bz);
      sky = (s & 255) / 255;
      block = ((s >> 8) & 255) / 255;
      ao = AO_FACTOR[(s >> 16) & 3];
    }
    const r = quantByte(shade * ao);
    const skyQ = quantByte(sky);
    const blockQ = quantByte(block);
    const vertexKey = textureKey * 16777216 + r * 65536 + skyQ * 256 + blockQ;
    if (i === 0) {
      key = vertexKey;
      out = { key, rect, r: r / 255, sky: skyQ / 255, block: blockQ / 255 };
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
  grids: (GreedyGrid | null)[],
  dir: Direction, slice: number, u: number, v: number, cell: GreedyCell,
) {
  const gridIndex = DIRECTION_INDEX[dir] * 17 + slice;
  let grid = grids[gridIndex];
  if (!grid) {
    grid = { dir, slice, cells: new Array<GreedyCell | null>(16 * 16).fill(null) };
    grids[gridIndex] = grid;
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
    builder.vertex(x, y, z, u, v, cell.r, cell.r, cell.r, cell.sky, cell.block, cell.rect);
  }
  builder.quadIndices();
}

function flushGreedyGrids(grids: (GreedyGrid | null)[], builder: MeshBuilder) {
  for (const grid of grids) {
    if (!grid) continue;
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
    if (!blockOccludes(res, view, wx + d[0], wy + d[1], wz + d[2])) return false;
  }
  return true;
}

function emitFluid(
  res: MesherResources, view: WorldView, builders: MeshBuilderStore,
  fluid: NonNullable<BlockInfo['fluid']>, state: BlockStateRef,
  lx: number, ly: number, lz: number, wx: number, wy: number, wz: number,
) {
  const builder = builderFor(builders, fluid.layer ?? 'translucent');
  const tint = res.tint(fluid.tint, undefined, view.getBiome(wx, wy, wz), state);
  const above = view.getBlock(wx, wy + 1, wz);
  const aboveSame = isSameFluid(res, fluid.texture, above);
  const aboveOccludes = blockOccludes(res, view, wx, wy + 1, wz);
  const sky = view.getSkyLight(wx, wy, wz) / 15;
  const block = view.getBlockLight(wx, wy, wz) / 15;

  // Modern palettes expose the fluid `level` property (0 = source, 1..7 =
  // horizontal flow, 8..15 = falling flow). A few converted worlds preserve
  // the same value under a metadata/fluid_level key, so accept those too.
  const fluidLevel = (s: BlockStateRef): number => {
    const raw = s.properties.level ?? s.properties.fluid_level ?? s.properties.metadata ?? '0';
    const level = Number(raw);
    if (!Number.isFinite(level)) return s.properties.falling === 'true' ? 8 : 0;
    return Math.max(0, Math.min(15, Math.floor(level)));
  };
  const fluidLevelHeight = (s: BlockStateRef): number => {
    const level = fluidLevel(s);
    // FluidState#getHeight uses 8 / 9 for a source or falling fluid. This is
    // intentionally neither 14/16 nor a full block: the renderer adds a tiny
    // top-surface offset below, exactly like vanilla's FluidRenderer.
    if (!Number.isFinite(level) || level <= 0 || level >= 8) return 8 / 9;
    return Math.max(1 / 16, (8 - level) / 9);
  };
  const surfaceHeightAt = (x: number, z: number): number => {
    const s = x === wx && z === wz ? state : view.getBlock(x, wy, z);
    if (!isSameFluid(res, fluid.texture, s)) return 0;
    const a = view.getBlock(x, wy + 1, z);
    // Cave fluids capped by a full occluder render as a full-height column;
    // their top is hidden separately by `aboveOccludes` below. Keep this
    // geometry rule out of the horizontal flow-vector calculation.
    if (isSameFluid(res, fluid.texture, a) || blockOccludes(res, view, x, wy + 1, z)) return 1;
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

  // This mirrors FluidState#getFlow closely enough for a mesh renderer: a
  // lower neighbouring surface pulls the flow toward itself. The sprite
  // selection must be based on this state, not merely on which face happens
  // to be exposed, otherwise a sloped/descending top keeps water_still.
  // Rendering height and fluid velocity are related but not interchangeable.
  // In particular, a solid cave roof promotes the rendered column to height 1
  // without imparting horizontal velocity. Using `surfaceHeightAt` here made
  // a still source next to covered tuff/deepslate/sculk select the flow sprite.
  const flowHeightAt = (x: number, z: number): number => {
    const s = x === wx && z === wz ? state : view.getBlock(x, wy, z);
    if (!isSameFluid(res, fluid.texture, s)) return 0;
    const aboveState = view.getBlock(x, wy + 1, z);
    return isSameFluid(res, fluid.texture, aboveState) ? 1 : fluidLevelHeight(s);
  };
  const currentFlowHeight = flowHeightAt(wx, wz);
  const flowSurfaceAt = (x: number, z: number): number => {
    const neighborState = view.getBlock(x, wy, z);
    // A solid boundary is not a lower fluid surface. Counting it as height 0
    // gave every still pool edge a fake outward velocity and selected the
    // flowing sprite around the entire shoreline.
    if (!isSameFluid(res, fluid.texture, neighborState) && blockOccludes(res, view, x, wy, z)) {
      return currentFlowHeight;
    }
    return flowHeightAt(x, z);
  };
  const flowX = flowSurfaceAt(wx - 1, wz) - flowSurfaceAt(wx + 1, wz);
  const flowZ = flowSurfaceAt(wx, wz - 1) - flowSurfaceAt(wx, wz + 1);
  // Vanilla selects the flowing sprite from the horizontal flow vector, not
  // directly from the encoded fluid level. Equal-height non-source or falling
  // columns can still have a zero horizontal vector and use the still sprite.
  const flowingTop = !!fluid.flowTexture
    && (Math.abs(flowX) > HEIGHT_EPS || Math.abs(flowZ) > HEIGHT_EPS);
  const flowAngle = Math.atan2(flowZ, flowX) - Math.PI / 2;
  const flowCos = Math.cos(flowAngle);
  const flowSin = Math.sin(flowAngle);

  const faceUv = (dir: Direction, v: [number, number, number]): [number, number] => {
    const s = 16;
    const [v0, v1, v2] = v;
    switch (dir) {
      case 'down': return [v0 * s, s - v2 * s];
      case 'up': return [v0 * s, v2 * s];
      case 'north': return [s - v0 * s, s - v1 * s];
      case 'south': return [v0 * s, s - v1 * s];
      case 'west': return [v2 * s, s - v1 * s];
      case 'east': return [s - v2 * s, s - v1 * s];
    }
  };
  const flowTopUv = (v: [number, number, number]): [number, number] => {
    // These four coordinates deliberately form vanilla's rotated diamond,
    // not an affine texture rotation. In particular, the south-east vertex
    // has `cos - sin` for V; treating it as a square projection was the
    // source of the discontinuity visible on flowing water.
    const x = v[0], z = v[2];
    const s = 8;
    const q = 4;
    if (x < 0.5 && z < 0.5) return [s + q * (-flowCos - flowSin), s + q * (-flowCos + flowSin)];
    if (x < 0.5 && z >= 0.5) return [s + q * (-flowCos + flowSin), s + q * (flowCos + flowSin)];
    if (x >= 0.5 && z >= 0.5) return [s + q * (flowCos + flowSin), s + q * (flowCos - flowSin)];
    return [s + q * (flowCos - flowSin), s + q * (-flowCos - flowSin)];
  };

  const face = (
    dir: Direction, verts: [number, number, number][], explicitUvs?: [number, number][],
  ) => {
    const texture = dir === 'up'
      ? (flowingTop ? fluid.flowTexture! : fluid.texture)
      : dir === 'down'
        ? fluid.texture
        : (fluid.flowTexture ?? fluid.texture);
    const rect = res.atlas[texture] ?? res.atlas[MISSING_TEXTURE];
    const shade = SHADE[dir];
    verts.forEach((v) => {
      const uv = explicitUvs?.[verts.indexOf(v)] ?? (dir === 'up' && flowingTop ? flowTopUv(v) : faceUv(dir, v));
      const [u, vv] = atlasUv(rect, ...uv);
      builder.vertex(
        lx + v[0], ly + v[1], lz + v[2], u, vv,
        tint[0] * shade, tint[1] * shade, tint[2] * shade, sky, block,
        undefined, res.textureAnimationIds?.[texture] ?? 0,
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
    const d = DIR_VEC[dir];
    return !blockOccludes(res, view, wx + d[0], wy + d[1], wz + d[2]);
  };
  const side = (
    dir: Direction,
    top: [[number, number, number], [number, number, number]],
    bottomWhenAir: [[number, number, number], [number, number, number]],
    neighborBottom: () => [[number, number, number], [number, number, number]],
  ) => {
    const inset = (v: [number, number, number]): [number, number, number] => {
      if (dir === 'north') return [v[0], v[1], v[2] + 0.001];
      if (dir === 'south') return [v[0], v[1], v[2] - 0.001];
      if (dir === 'west') return [v[0] + 0.001, v[1], v[2]];
      if (dir === 'east') return [v[0] - 0.001, v[1], v[2]];
      return v;
    };
    const emitSide = (
      topA: [number, number, number], topB: [number, number, number],
      bottomB: [number, number, number], bottomA: [number, number, number],
    ) => face(dir, [inset(topA), inset(topB), inset(bottomB), inset(bottomA)], sideUvs(topA, topB, bottomB, bottomA));
    const n = neighbor(dir);
    if (isSameFluid(res, fluid.texture, n)) {
      const bottom = neighborBottom();
      const visible = top[0][1] > bottom[0][1] + HEIGHT_EPS || top[1][1] > bottom[1][1] + HEIGHT_EPS;
      if (visible) emitSide(top[0], top[1], bottom[1], bottom[0]);
    } else {
      const d = DIR_VEC[dir];
      if (blockOccludes(res, view, wx + d[0], wy + d[1], wz + d[2])) return;
      emitSide(top[0], top[1], bottomWhenAir[1], bottomWhenAir[0]);
    }
  };

  const sideUvs = (
    topA: [number, number, number], topB: [number, number, number],
    bottomB: [number, number, number], bottomA: [number, number, number],
  ): [number, number][] => {
    // FluidRenderer maps every exposed side to the lower-left 8×8 region of
    // the flowing sprite: U 0..8 and V (1-height)*8..8. The winding comes
    // from the face vertices, so it must not be re-projected by world axis.
    const vA = (1 - topA[1]) * 8;
    const vB = (1 - topB[1]) * 8;
    // `face` stores side vertices in the renderer's counter-clockwise order
    // (the inverse of FluidRenderer's emission order), hence U is 8..0 here.
    return [[8, vA], [0, vB], [0, 8], [8, 8]];
  };

  // Vanilla keeps the fluid surface just inside the block to avoid depth
  // fighting with an adjacent top face. Apply the same 0.001 offset to all
  // four corners, including still/source fluids.
  const topY = (h: number) => Math.max(0, h - 0.001);
  if (!aboveSame && !aboveOccludes) {
    face('up', [[0, topY(hNW), 0], [1, topY(hNE), 0], [1, topY(hSE), 1], [0, topY(hSW), 1]]);
  }
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
  renderInstances: readonly RenderModelInstance[] = [],
): MeshSectionResult {
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
  const cachedView = new SectionViewCache(localRes, view, cx, sy, cz);
  const hasRenderInstances = renderInstances.some((instance) => Math.floor(instance.y / 16) === sy);
  if (cachedView.isSealedOccluderSection() && !hasRenderInstances) return { layers: {}, visibility: 0 };
  const textureIds = new Map<string, number>();
  const textureKeyOf = (texture: string): number => {
    let id = textureIds.get(texture);
    if (id === undefined) {
      id = textureIds.size + 1;
      textureIds.set(texture, id);
    }
    return id;
  };
  const metaCache = new WeakMap<BlockStateRef, BlockStateMeshMeta>();
  const metaOf = (state: BlockStateRef): BlockStateMeshMeta => {
    let hit = metaCache.get(state);
    if (!hit) {
      const bi = cachedInfo(state.name);
      const blockLayer = bi.layer === 'opaqueTiled' ? 'opaque' : bi.layer;
      const waterlogged = state.properties.waterlogged === 'true' || !!bi.waterlogged;
      const fullOccluder = bi.occludes
        && opaqueFullCubeFromQuads(localRes.baker.getQuads(state, 0), localRes.textureHasAlpha);
      hit = {
        bi,
        blockLayer,
        waterlogged,
        fullOccluder,
        simpleEligible: !waterlogged
          && blockLayer === 'opaque'
          && bi.occludes
          && bi.tint === 'none'
          && bi.fixedTint === undefined,
      };
      metaCache.set(state, hit);
    }
    return hit;
  };
  const faceOccluded = (q: BakedQuad, state: BlockStateRef, x: number, y: number, z: number): boolean => {
    if (!q.cullFace) return false;
    const d = DIR_VEC[q.cullFace];
    const nx = x + d[0], ny = y + d[1], nz = z + d[2];
    if (cachedView.occludesLocal(nx, ny, nz)) return true;
    const neighbor = cachedView.blockLocal(nx, ny, nz);
    if (AIR_NAMES.has(neighbor.name)) return false;
    const nInfo = cachedInfo(neighbor.name);
    const sameTranslucent = cachedInfo(state.name).layer === 'translucent' && neighbor.name === state.name;
    if (nInfo.layer === 'translucent' && !sameTranslucent) return false;
    const opposite = OPPOSITE_DIRECTION[q.cullFace];
    const neighborQuads = localRes.baker.getQuads(neighbor, hash3(nx + ox, ny + oy, nz + oz));
    return neighborQuads.some((candidate) => candidate.face === opposite
      && candidate.cullFace === opposite
      && (sameTranslucent || !localRes.textureHasAlpha?.[candidate.texture])
      && faceCovers(candidate, q, q.cullFace!));
  };
  const builders: MeshBuilderStore = {};
  const greedyGrids = new Array<GreedyGrid | null>(6 * 17).fill(null);
  const ox = cx * 16, oy = sy * 16, oz = cz * 16;
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const wx = ox + x, wy = oy + y, wz = oz + z;
        const state = cachedView.blockLocal(x, y, z);
        if (AIR_NAMES.has(state.name)) continue;
        const meta = metaOf(state);
        const { bi, blockLayer, waterlogged, fullOccluder } = meta;

        if (bi.fluid) {
          emitFluid(localRes, cachedView, builders, bi.fluid, state, x, y, z, wx, wy, wz);
          continue;
        }
        if (waterlogged) {
          const water = cachedInfo('minecraft:water').fluid;
          if (water) emitFluid(localRes, cachedView, builders, water, { name: 'minecraft:water', properties: { level: '0' } }, x, y, z, wx, wy, wz);
        }
        let occludedFaceMask = -1;
        if (!waterlogged && fullOccluder) {
          occludedFaceMask = 0;
          for (const dir of SECTION_VISIBILITY_DIRECTIONS) {
            const d = DIR_VEC[dir];
            if (cachedView.occludesLocal(x + d[0], y + d[1], z + d[2])) occludedFaceMask |= 1 << DIRECTION_INDEX[dir];
          }
          if (occludedFaceMask === ALL_DIRECTIONS_OCCLUDED) continue;
        }

        const quads = localRes.baker.getQuads(state, hash3(wx, wy, wz));
        const simple = meta.simpleEligible ? cachedSimpleCube(quads, localRes.textureHasAlpha, localRes.textureAnimationIds) : null;
        if (simple) {
          for (const dir of SECTION_VISIBILITY_DIRECTIONS) {
            const q = simple[dir];
            const d = DIR_VEC[dir];
            if (occludedFaceMask >= 0
              ? (occludedFaceMask & (1 << DIRECTION_INDEX[dir])) !== 0
              : cachedView.occludesLocal(x + d[0], y + d[1], z + d[2])) continue;
            const cell = greedyCellForQuad(localRes, cachedView, q, textureKeyOf(q.texture), wx, wy, wz, smoothLighting);
            if (cell) {
              const coord = greedyCoords(dir, x, y, z);
              addGreedyCell(greedyGrids, dir, coord.slice, coord.u, coord.v, cell);
            } else {
              emitQuad(localRes, cachedView, builderFor(builders, 'opaque'), q, x, y, z, wx, wy, wz, WHITE, smoothLighting);
            }
          }
          continue;
        }

        for (const q of quads) {
          if (q.cullFace) {
            if (occludedFaceMask >= 0
              ? (occludedFaceMask & (1 << DIRECTION_INDEX[q.cullFace])) !== 0
              : faceOccluded(q, state, x, y, z)) continue;
          }
          const tint = q.tintIndex >= 0
            ? localRes.tint(bi.tint, bi.fixedTint, cachedView.getBiome(wx, wy, wz), state)
            : WHITE;
          const layer = blockLayer === 'opaque' && localRes.textureHasAlpha?.[q.texture] ? 'cutout' : blockLayer;
          emitQuad(localRes, cachedView, builderFor(builders, layer), q, x, y, z, wx, wy, wz, tint, smoothLighting);
        }
      }
    }
  }
  for (const instance of renderInstances) {
    if (Math.floor(instance.y / 16) !== sy) continue;
    const quads = localRes.baker.getModelQuads(instance.model);
    const lx = instance.x - ox;
    const ly = instance.y - oy;
    const lz = instance.z - oz;
    const builder = builderFor(builders, specialLayer(instance.layer));
    for (const quad of quads) {
      const q = transformedRenderQuad(quad, instance);
      emitQuad(localRes, cachedView, builder, q, lx, ly, lz, instance.x, instance.y, instance.z, WHITE, false);
    }
  }
  if (greedyGrids.some(Boolean)) flushGreedyGrids(greedyGrids, builderFor(builders, 'opaqueTiled'));
  const layers: SectionMeshes = {};
  for (const layer of [
    'opaque', 'opaqueTiled', 'cutout', 'translucent',
    'specialOpaque', 'specialCutout', 'specialTranslucent',
  ] as RenderLayer[]) {
    const builder = builders[layer];
    if (builder && !builder.empty) layers[layer] = builder.build();
  }
  return { layers, visibility: cachedView.visibilityMask() };
}

function visibilityBit(from: number, to: number): number {
  return 2 ** (from * SECTION_VISIBILITY_DIRECTIONS.length + to);
}
