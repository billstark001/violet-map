import { AIR, AIR_NAMES, ChunkColumn } from '../world.js';
import { BlockInfo, BlockStateRef, Direction, DIR_VEC, MeshBuffers } from '../types.js';
import type { Rgb } from '../colors.js';
import { Float32Writer, Uint32Writer } from '../utils.js';

interface LodWorldView {
  getBlock(x: number, y: number, z: number): BlockStateRef;
  getBiome(x: number, y: number, z: number): string;
  getSkyLight?(x: number, y: number, z: number): number;
  getBlockLight?(x: number, y: number, z: number): number;
}

interface LodShape {
  minY: number;
  maxY: number;
  sideMaxY: number;
  occludes: boolean;
  fluidTexture?: string;
}

interface FaceBucket {
  dir: Direction;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
  r: number;
  g: number;
  b: number;
  sky: number;
  block: number;
  count: number;
}

const DEFAULT_INFO: BlockInfo = { occludes: true, emit: 0, filter: 15, layer: 'opaque', tint: 'none' };
const SHADE: Record<Direction, number> = { up: 1, down: 0.5, north: 0.8, south: 0.8, west: 0.6, east: 0.6 };
const EPS = 1e-4;
const COORD_SCALE = 1024;
const NO_SKY_PADDING = 1;
const LOD_POSITION_XZ_SCALE = 16;
const LOD_POSITION_Y_SCALE = 4096;
const LOD_POSITION_Y_OFFSET = -2048;

const THIN_DECORATION = new Set([
  'air',
  'cave_air',
  'void_air',
  'short_grass',
  'grass',
  'tall_grass',
  'fern',
  'large_fern',
  'dead_bush',
  'seagrass',
  'tall_seagrass',
  'kelp',
  'kelp_plant',
  'vine',
  'cave_vines',
  'cave_vines_plant',
  'glow_lichen',
  'spore_blossom',
  'redstone_wire',
  'tripwire',
  'tripwire_hook',
  'lever',
  'ladder',
  'chain',
  'lantern',
  'soul_lantern',
  'flower_pot',
  'brown_mushroom',
  'red_mushroom',
  'crimson_fungus',
  'warped_fungus',
  'nether_sprouts',
  'weeping_vines',
  'weeping_vines_plant',
  'twisting_vines',
  'twisting_vines_plant',
  'pointed_dripstone',
  'amethyst_cluster',
  'large_amethyst_bud',
  'medium_amethyst_bud',
  'small_amethyst_bud',
  'rail',
  'powered_rail',
  'detector_rail',
  'activator_rail',
]);

const THIN_SUFFIXES = [
  '_sapling',
  '_flower',
  '_tulip',
  '_torch',
  '_wall_torch',
  '_button',
  '_banner',
  '_coral',
  '_coral_fan',
  '_wall_fan',
  '_roots',
];

class LodBuilder {
  pos = new Float32Writer(1024 * 3);
  col = new Float32Writer(1024 * 3);
  light = new Float32Writer(1024 * 2);
  idx = new Uint32Writer(1024 * 6);
  verts = 0;

  vertex(x: number, y: number, z: number, color: Rgb, light: [number, number], shade: number) {
    this.pos.push3(x, y, z);
    this.col.push3(color[0] * shade, color[1] * shade, color[2] * shade);
    this.light.push2(light[0], light[1]);
    this.verts++;
  }

  quad(verts: [number, number, number][], color: Rgb, light: [number, number], shade: number) {
    for (const v of verts) this.vertex(v[0], v[1], v[2], color, light, shade);
    const b = this.verts - 4;
    this.idx.push6(b, b + 2, b + 1, b, b + 3, b + 2);
  }

  build(): MeshBuffers {
    const positions = this.pos.view();
    const colors = this.col.view();
    const lights = this.light.view();
    const indices = this.idx.view();
    return {
      positions: packLodPositions(positions),
      colors: packNormalizedUint8(colors),
      lights: packNormalizedUint8(lights),
      indices: packIndices(indices, this.verts),
      bounds: boundsOfPositions(positions),
    };
  }
}

function packNormalizedUint8(values: Float32Array): Uint8Array {
  const out = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Math.round(Math.min(1, Math.max(0, values[i])) * 255);
  return out;
}

function packLodPositions(values: Float32Array): Uint16Array {
  const out = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i += 3) {
    out[i] = Math.round(Math.min(1, Math.max(0, values[i] / LOD_POSITION_XZ_SCALE)) * 65535);
    out[i + 1] = Math.round(Math.min(1, Math.max(0, (values[i + 1] - LOD_POSITION_Y_OFFSET) / LOD_POSITION_Y_SCALE)) * 65535);
    out[i + 2] = Math.round(Math.min(1, Math.max(0, values[i + 2] / LOD_POSITION_XZ_SCALE)) * 65535);
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

const FACE_DIRECTIONS: Direction[] = ['up', 'down', 'north', 'south', 'west', 'east'];
const FACE_DIR_INDEX: Record<Direction, number> = { up: 0, down: 1, north: 2, south: 3, west: 4, east: 5 };
const GRID_COORD_RADIX = 32;
const GRID_COORD_MAX = GRID_COORD_RADIX - 1;

function gridCoordKey(v: number): number {
  return Math.max(0, Math.min(GRID_COORD_MAX, Math.round(v)));
}

function packGrid4(a: number, b: number, c: number, d: number): number {
  return (((a * GRID_COORD_RADIX + b) * GRID_COORD_RADIX + c) * GRID_COORD_RADIX + d);
}

function facePlaneKey(dir: Direction, x0: number, x1: number, z0: number, z1: number): number {
  switch (dir) {
    case 'up':
    case 'down':
      return packGrid4(gridCoordKey(x0), gridCoordKey(x1), gridCoordKey(z0), gridCoordKey(z1));
    case 'north':
    case 'south':
      return packGrid4(gridCoordKey(x0), gridCoordKey(x1), gridCoordKey(z0), 0);
    case 'west':
    case 'east':
      return packGrid4(gridCoordKey(x0), gridCoordKey(z0), gridCoordKey(z1), 0);
    default:
      return 0;
  }
}

const Y_COORD_BIAS = 2 ** 22;
const Y_COORD_RADIX = 2 ** 23;

function faceHeightKey(y0: number, y1: number): number {
  return (coordKey(y0) + Y_COORD_BIAS) * Y_COORD_RADIX + coordKey(y1) + Y_COORD_BIAS;
}

class LodFaceAccumulator {
  private buckets = FACE_DIRECTIONS.map(() => new Map<number, Map<number, FaceBucket>>());
  private bucketCount = 0;

  get empty() { return this.bucketCount === 0; }

  add(
    dir: Direction,
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    z0: number,
    z1: number,
    color: Rgb,
    sky: number,
    block: number,
  ) {
    if (Math.abs(x1 - x0) <= EPS && (dir === 'up' || dir === 'down' || dir === 'north' || dir === 'south')) return;
    if (Math.abs(z1 - z0) <= EPS && (dir === 'up' || dir === 'down' || dir === 'west' || dir === 'east')) return;
    if (Math.abs(y1 - y0) <= EPS && dir !== 'up' && dir !== 'down') return;

    const dirIndex = FACE_DIR_INDEX[dir];
    const planeKey = facePlaneKey(dir, x0, x1, z0, z1);
    const heightKey = faceHeightKey(y0, y1);
    const dirBuckets = this.buckets[dirIndex];
    let heightBuckets = dirBuckets.get(planeKey);

    if (!heightBuckets) {
      heightBuckets = new Map<number, FaceBucket>();
      dirBuckets.set(planeKey, heightBuckets);
    } else {
      const hit = heightBuckets.get(heightKey);
      if (hit) {
        hit.r += color[0];
        hit.g += color[1];
        hit.b += color[2];
        hit.sky += sky;
        hit.block += block;
        hit.count++;
        return;
      }
    }

    heightBuckets.set(heightKey, {
      dir,
      x0,
      x1,
      y0,
      y1,
      z0,
      z1,
      r: color[0],
      g: color[1],
      b: color[2],
      sky,
      block,
      count: 1,
    });
    this.bucketCount++;
  }

  flush(builder: LodBuilder) {
    for (const dirBuckets of this.buckets) {
      for (const heightBuckets of dirBuckets.values()) {
        for (const f of heightBuckets.values()) {
          const color: Rgb = [f.r / f.count, f.g / f.count, f.b / f.count];
          const light: [number, number] = [f.sky / f.count, f.block / f.count];
          switch (f.dir) {
            case 'up':
              builder.quad([[f.x0, f.y0, f.z0], [f.x1, f.y0, f.z0], [f.x1, f.y0, f.z1], [f.x0, f.y0, f.z1]], color, light, SHADE.up);
              break;
            case 'down':
              builder.quad([[f.x0, f.y0, f.z1], [f.x1, f.y0, f.z1], [f.x1, f.y0, f.z0], [f.x0, f.y0, f.z0]], color, light, SHADE.down);
              break;
            case 'north':
              builder.quad([[f.x1, f.y1, f.z0], [f.x0, f.y1, f.z0], [f.x0, f.y0, f.z0], [f.x1, f.y0, f.z0]], color, light, SHADE.north);
              break;
            case 'south':
              builder.quad([[f.x0, f.y1, f.z0], [f.x1, f.y1, f.z0], [f.x1, f.y0, f.z0], [f.x0, f.y0, f.z0]], color, light, SHADE.south);
              break;
            case 'west':
              builder.quad([[f.x0, f.y1, f.z0], [f.x0, f.y1, f.z1], [f.x0, f.y0, f.z1], [f.x0, f.y0, f.z0]], color, light, SHADE.west);
              break;
            case 'east':
              builder.quad([[f.x0, f.y1, f.z1], [f.x0, f.y1, f.z0], [f.x0, f.y0, f.z0], [f.x0, f.y0, f.z1]], color, light, SHADE.east);
              break;
          }
        }
      }
    }
  }
}

function coordKey(v: number): number {
  return Math.round(v * COORD_SCALE);
}

function localName(name: string): string {
  const separator = name.indexOf(':');
  return separator >= 0 ? name.slice(separator + 1) : name;
}

function isThinDecoration(state: BlockStateRef, info: BlockInfo): boolean {
  if (info.occludes || info.fluid) return false;
  const local = localName(state.name);
  if (local.endsWith('_leaves')) return false;
  if (local.endsWith('_slab') || local.endsWith('_stairs') || local.endsWith('_wall') || local.endsWith('_fence') || local.endsWith('_fence_gate')) return false;
  if (local.endsWith('_pane') || local.endsWith('_glass') || local.endsWith('_ice')) return false;
  if (THIN_DECORATION.has(local)) return true;
  return THIN_SUFFIXES.some((suffix) => local.endsWith(suffix));
}

function fluidLevelHeight(state: BlockStateRef): number {
  const level = Number(state.properties.level ?? '0');
  if (!Number.isFinite(level) || level <= 0 || level >= 8) return 14 / 16;
  return Math.max(1 / 16, (8 - level) / 9);
}

function shapeOf(state: BlockStateRef, info: BlockInfo): LodShape | null {
  if (AIR_NAMES.has(state.name) || isThinDecoration(state, info)) return null;

  const local = localName(state.name);
  let minY = 0;
  let maxY = info.fluid ? fluidLevelHeight(state) : 1;

  if (!info.fluid) {
    if (local.endsWith('_slab')) {
      const type = state.properties.type;
      if (type === 'top') minY = 0.5;
      else if (type !== 'double') maxY = 0.5;
    } else if (local === 'snow') {
      const layers = Math.min(8, Math.max(1, Number(state.properties.layers ?? '1') || 1));
      maxY = layers / 8;
    } else if (local.endsWith('_carpet') || local === 'lily_pad') {
      maxY = 1 / 16;
    } else if (local === 'farmland' || local === 'dirt_path') {
      maxY = 15 / 16;
    } else if (local.endsWith('_pressure_plate') || local === 'heavy_weighted_pressure_plate' || local === 'light_weighted_pressure_plate') {
      maxY = 1 / 16;
    } else if (local.endsWith('_trapdoor') && state.properties.open !== 'true') {
      if (state.properties.half === 'top') minY = 13 / 16;
      else maxY = 3 / 16;
    }
  }

  minY = Math.min(1, Math.max(0, minY));
  maxY = Math.min(1, Math.max(0, maxY));
  return maxY - minY > EPS ? { minY, maxY, sideMaxY: maxY, occludes: info.occludes, fluidTexture: info.fluid?.texture } : null;
}

const LOD_SHAPE_CACHE = new WeakMap<BlockStateRef, { info: BlockInfo; shape: LodShape | null }>();

function cachedLodShape(state: BlockStateRef, info: BlockInfo): LodShape | null {
  const cached = LOD_SHAPE_CACHE.get(state);
  if (cached?.info === info) return cached.shape;
  const shape = shapeOf(state, info);
  LOD_SHAPE_CACHE.set(state, { info, shape });
  return shape;
}

function makeLocalView(col: ChunkColumn): LodWorldView {
  const ox = col.x * 16;
  const oz = col.z * 16;
  return {
    getBlock(x, y, z) {
      if (x < ox || x >= ox + 16 || z < oz || z >= oz + 16) return AIR;
      return col.getBlock(x - ox, y, z - oz);
    },
    getBiome(x, y, z) {
      if (x < ox || x >= ox + 16 || z < oz || z >= oz + 16) return 'minecraft:plains';
      return col.getBiome(x - ox, y, z - oz);
    },
    getSkyLight(x, y, z) {
      if (x < ox || x >= ox + 16 || z < oz || z >= oz + 16) return 15;
      return col.getSkyLight(x - ox, y, z - oz);
    },
    getBlockLight(x, y, z) {
      if (x < ox || x >= ox + 16 || z < oz || z >= oz + 16) return 0;
      return col.getBlockLight(x - ox, y, z - oz);
    },
  };
}

function quantFloor(v: number, step: number): number {
  return Math.max(0, Math.min(16, Math.floor((v + EPS) / step) * step));
}

function quantCeil(v: number, step: number): number {
  return Math.max(0, Math.min(16, Math.ceil((v - EPS) / step) * step));
}

const SKY_EXPOSURE_CACHE = new WeakMap<Uint8Array, boolean>();

function sectionHasSkyExposure(section: { skyLight: Uint8Array | null }): boolean {
  const light = section.skyLight;
  if (!light) return true;
  const cached = SKY_EXPOSURE_CACHE.get(light);
  if (cached !== undefined) return cached;
  for (let i = 0; i < light.length; i++) {
    if (light[i] > 0) {
      SKY_EXPOSURE_CACHE.set(light, true);
      return true;
    }
  }
  SKY_EXPOSURE_CACHE.set(light, false);
  return false;
}

const LOD_CACHE_SIZE = 18;
const LOD_CACHE_PLANE = LOD_CACHE_SIZE * LOD_CACHE_SIZE;
const LOD_CACHE_CELLS = LOD_CACHE_PLANE * LOD_CACHE_SIZE;

function lodCacheIndex(x: number, y: number, z: number): number {
  return (y * LOD_CACHE_SIZE + z) * LOD_CACHE_SIZE + x;
}

interface SectionLodCache {
  shapes: (LodShape | null)[];
  exterior: Uint8Array;
}

interface SurfaceCell {
  y: number;
  color: Rgb | null;
}

function createSectionLodCacheScratch(): SectionLodCache {
  return { shapes: new Array<LodShape | null>(LOD_CACHE_CELLS), exterior: new Uint8Array(LOD_CACHE_CELLS) };
}

function buildSectionLodCache(
  cache: SectionLodCache,
  view: LodWorldView,
  section: { block(x: number, y: number, z: number): BlockStateRef; skyLight: Uint8Array | null },
  ox: number,
  sy: number,
  oz: number,
  shapeFor: (state: BlockStateRef) => LodShape | null,
  exteriorFor: (wx: number, wy: number, wz: number) => boolean,
  directSkyLight: Uint8Array | null,
): SectionLodCache {
  const { shapes, exterior } = cache;
  const oy = sy * 16;
  for (let y = 0; y < LOD_CACHE_SIZE; y++) {
    const ly = y - 1;
    const insideY = ly >= 0 && ly < 16;
    const wy = oy + ly;
    for (let z = 0; z < LOD_CACHE_SIZE; z++) {
      const lz = z - 1;
      const insideZ = lz >= 0 && lz < 16;
      const wz = oz + lz;
      for (let x = 0; x < LOD_CACHE_SIZE; x++) {
        const lx = x - 1;
        const inside = insideY && insideZ && lx >= 0 && lx < 16;
        const wx = ox + lx;
        const i = lodCacheIndex(x, y, z);
        shapes[i] = shapeFor(inside ? section.block(lx, ly, lz) : view.getBlock(wx, wy, wz));
        if (inside && directSkyLight) {
          exterior[i] = directSkyLight[(ly << 8) | (lz << 4) | lx] > 0 ? 1 : 0;
        } else {
          exterior[i] = exteriorFor(wx, wy, wz) ? 1 : 0;
        }
      }
    }
  }
  return cache;
}

function makeNoSkyExteriorMask(
  view: LodWorldView,
  col: ChunkColumn,
  shapeFor: (state: BlockStateRef) => LodShape | null,
): (wx: number, wy: number, wz: number) => boolean {
  const minX = col.x * 16 - NO_SKY_PADDING;
  const minZ = col.z * 16 - NO_SKY_PADDING;
  const minY = col.minY - NO_SKY_PADDING;
  const sizeX = 16 + NO_SKY_PADDING * 2;
  const sizeZ = 16 + NO_SKY_PADDING * 2;
  const sizeY = Math.max(1, col.maxY - col.minY + NO_SKY_PADDING * 2);
  const strideY = sizeX * sizeZ;
  const total = strideY * sizeY;
  const exterior = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  const idx = (x: number, y: number, z: number) => x + z * sizeX + y * strideY;
  const passable = (x: number, y: number, z: number) => {
    const state = view.getBlock(minX + x, minY + y, minZ + z);
    return shapeFor(state) === null;
  };
  const push = (x: number, y: number, z: number) => {
    const i = idx(x, y, z);
    if (exterior[i] || !passable(x, y, z)) return;
    exterior[i] = 1;
    queue[tail++] = i;
  };

  for (let y = 0; y < sizeY; y++) {
    for (let z = 0; z < sizeZ; z++) {
      push(0, y, z);
      push(sizeX - 1, y, z);
    }
    for (let x = 1; x < sizeX - 1; x++) {
      push(x, y, 0);
      push(x, y, sizeZ - 1);
    }
  }
  for (let z = 1; z < sizeZ - 1; z++) {
    for (let x = 1; x < sizeX - 1; x++) {
      push(x, 0, z);
      push(x, sizeY - 1, z);
    }
  }

  while (head < tail) {
    const i = queue[head++];
    const y = Math.floor(i / strideY);
    const rem = i - y * strideY;
    const z = Math.floor(rem / sizeX);
    const x = rem - z * sizeX;
    if (x > 0) push(x - 1, y, z);
    if (x + 1 < sizeX) push(x + 1, y, z);
    if (y > 0) push(x, y - 1, z);
    if (y + 1 < sizeY) push(x, y + 1, z);
    if (z > 0) push(x, y, z - 1);
    if (z + 1 < sizeZ) push(x, y, z + 1);
  }

  return (wx: number, wy: number, wz: number) => {
    const x = wx - minX;
    const y = wy - minY;
    const z = wz - minZ;
    if (x < 0 || x >= sizeX || y < 0 || y >= sizeY || z < 0 || z >= sizeZ) return true;
    return exterior[idx(x, y, z)] > 0;
  };
}

function sideMaxYForShapes(shape: LodShape, above: LodShape | null): number {
  if (!shape.fluidTexture) return shape.sideMaxY;
  if (above?.fluidTexture === shape.fluidTexture || above?.occludes) return 1;
  return shape.maxY;
}

/** Packs the two four-bit light levels to avoid allocating a tuple for every face. */
function packedFaceLight(
  view: LodWorldView,
  hasSkyLight: boolean,
  dir: Direction,
  wx: number,
  wy: number,
  wz: number,
): number {
  const d = DIR_VEC[dir];
  const x = wx + d[0];
  const y = wy + d[1];
  const z = wz + d[2];
  const sky = hasSkyLight && view.getSkyLight ? Math.min(15, Math.max(0, view.getSkyLight(x, y, z))) : 0;
  const block = view.getBlockLight ? Math.min(15, Math.max(0, view.getBlockLight(x, y, z))) : 0;
  return Math.round(sky) | (Math.round(block) << 4);
}

function addLodFace(
  acc: LodFaceAccumulator,
  dir: Direction,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  color: Rgb,
  packedLight: number,
) {
  acc.add(dir, x0, x1, y0, y1, z0, z1, color, (packedLight & 15) / 15, ((packedLight >> 4) & 15) / 15);
}

function addLodSide(
  acc: LodFaceAccumulator,
  dir: 'north' | 'south' | 'west' | 'east',
  shape: LodShape,
  cover: LodShape | null,
  coverAbove: LodShape | null,
  sideMaxY: number,
  wy: number,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  color: Rgb,
  packedLight: number,
) {
  if (!cover) {
    addLodSideSegment(acc, dir, shape.minY, sideMaxY, wy, x0, x1, z0, z1, color, packedLight);
    return;
  }
  const coverSideMaxY = sideMaxYForShapes(cover, coverAbove);
  const coveredFrom = Math.max(shape.minY, cover.minY);
  const coveredTo = Math.min(sideMaxY, coverSideMaxY);
  if (coveredTo <= coveredFrom + EPS) {
    addLodSideSegment(acc, dir, shape.minY, sideMaxY, wy, x0, x1, z0, z1, color, packedLight);
    return;
  }
  addLodSideSegment(acc, dir, shape.minY, coveredFrom, wy, x0, x1, z0, z1, color, packedLight);
  addLodSideSegment(acc, dir, coveredTo, sideMaxY, wy, x0, x1, z0, z1, color, packedLight);
}

function addLodSideSegment(
  acc: LodFaceAccumulator,
  dir: 'north' | 'south' | 'west' | 'east',
  from: number,
  to: number,
  wy: number,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  color: Rgb,
  packedLight: number,
) {
  if (to <= from + EPS) return;
  const y0 = wy + from;
  const y1 = wy + to;
  switch (dir) {
    case 'north': addLodFace(acc, dir, x0, x1, y0, y1, z0, z0, color, packedLight); break;
    case 'south': addLodFace(acc, dir, x0, x1, y0, y1, z1, z1, color, packedLight); break;
    case 'west': addLodFace(acc, dir, x0, x0, y0, y1, z0, z1, color, packedLight); break;
    case 'east': addLodFace(acc, dir, x1, x1, y0, y1, z0, z1, color, packedLight); break;
  }
}

/**
 * 低 LOD：天空光维度的 step 2+ 走高度图表面快路径，避免远处洞穴/地下 section 拖慢调度。
 * no-sky 或 step 1 保留详细路径，用于需要保留桥底、树冠侧面、水面/半砖高度的场景。
 * y 为绝对坐标，x/z 相对区块原点。
 */
export function meshLodChunk(
  col: ChunkColumn,
  step: number,
  colorOf: (state: BlockStateRef, biome: string) => Rgb,
  hasSkyLight = true,
  worldView?: LodWorldView,
  infoOf: (name: string) => BlockInfo = () => DEFAULT_INFO,
): MeshBuffers | null {
  const lodStep = Math.max(1, Math.floor(step));
  if (!Number.isFinite(lodStep)) return null;
  const acc = new LodFaceAccumulator();
  const view = worldView ?? makeLocalView(col);
  const ox = col.x * 16;
  const oz = col.z * 16;
  const infoCache = new Map<string, BlockInfo>();

  const cachedInfo = (name: string): BlockInfo => {
    let hit = infoCache.get(name);
    if (!hit) {
      hit = infoOf(name);
      infoCache.set(name, hit);
    }
    return hit;
  };
  const cachedShape = (state: BlockStateRef): LodShape | null => {
    return cachedLodShape(state, cachedInfo(state.name));
  };
  const skyExterior = hasSkyLight && view.getSkyLight
    ? (wx: number, wy: number, wz: number) => view.getSkyLight!(wx, wy, wz) > 0
    : null;
  let noSkyExterior: ((wx: number, wy: number, wz: number) => boolean) | null = null;
  const exterior = (wx: number, wy: number, wz: number): boolean => {
    if (skyExterior) return skyExterior(wx, wy, wz);
    noSkyExterior ??= makeNoSkyExteriorMask(view, col, cachedShape);
    return noSkyExterior(wx, wy, wz);
  };

  const sectionCacheScratch = createSectionLodCacheScratch();

  for (const [sy, section] of col.sections) {
    if (section.isEmpty) continue;
    if (hasSkyLight && !sectionHasSkyExposure(section)) continue;
    const cache = buildSectionLodCache(sectionCacheScratch, view, section, ox, sy, oz, cachedShape, exterior, skyExterior ? section.skyLight : null);
    const { shapes, exterior: exteriorMask } = cache;
    for (let ly = 0; ly < 16; ly++) {
      const wy = sy * 16 + ly;
      const cacheY = ly + 1;
      for (let cellZ0 = 0; cellZ0 < 16; cellZ0 += lodStep) {
        const cellZ1 = Math.min(16, cellZ0 + lodStep);
        const z0 = quantFloor(cellZ0, lodStep);
        const z1 = quantCeil(cellZ1, lodStep);
        for (let cellX0 = 0; cellX0 < 16; cellX0 += lodStep) {
          const cellX1 = Math.min(16, cellX0 + lodStep);
          const x0 = quantFloor(cellX0, lodStep);
          const x1 = quantCeil(cellX1, lodStep);

          // 不要只选一个 representative block。那会把 cell 内部的局部可见面
          // 投影成整格大面，遇到悬崖、洞口、桥/水边时就会产生截图里的长条和破碎。
          // 这里仍按 LOD cell 分块处理，但在 cell 内扫描所有可见 block，输出继续由
          // LodFaceAccumulator 按 quantized cell 合并；几何语义等价于原实现，避免漏面/误面。
          for (let z = cellZ0; z < cellZ1; z++) {
            const cacheZ = z + 1;
            for (let x = cellX0; x < cellX1; x++) {
              const cacheX = x + 1;
              const cacheIndex = lodCacheIndex(cacheX, cacheY, cacheZ);
              const upIndex = cacheIndex + LOD_CACHE_PLANE;
              const downIndex = cacheIndex - LOD_CACHE_PLANE;
              const northIndex = cacheIndex - LOD_CACHE_SIZE;
              const southIndex = cacheIndex + LOD_CACHE_SIZE;
              const westIndex = cacheIndex - 1;
              const eastIndex = cacheIndex + 1;
              const shape = shapes[cacheIndex];
              if (!shape) continue;

              const exteriorUp = exteriorMask[upIndex] > 0;
              const exteriorDown = exteriorMask[downIndex] > 0;
              const exteriorNorth = exteriorMask[northIndex] > 0;
              const exteriorSouth = exteriorMask[southIndex] > 0;
              const exteriorWest = exteriorMask[westIndex] > 0;
              const exteriorEast = exteriorMask[eastIndex] > 0;
              if (!exteriorUp && !exteriorDown && !exteriorNorth && !exteriorSouth && !exteriorWest && !exteriorEast) continue;

              const state = section.block(x, ly, z);
              const wx = ox + x;
              const wz = oz + z;
              const color = colorOf(state, view.getBiome(wx, wy, wz));
              const y0 = wy + shape.minY;
              const y1 = wy + shape.maxY;
              const sideMaxY = sideMaxYForShapes(shape, shapes[upIndex]);

              if (exteriorUp) {
                const above = shapes[upIndex];
                if (!above || above.minY > EPS) {
                  addLodFace(acc, 'up', x0, x1, y1, y1, z0, z1, color, packedFaceLight(view, hasSkyLight, 'up', wx, wy, wz));
                }
              }

              if (exteriorDown) {
                const below = shapes[downIndex];
                if (!below || below.maxY < 1 - EPS) {
                  addLodFace(acc, 'down', x0, x1, y0, y0, z0, z1, color, packedFaceLight(view, hasSkyLight, 'down', wx, wy, wz));
                }
              }

              if (exteriorNorth) addLodSide(acc, 'north', shape, shapes[northIndex], shapes[northIndex + LOD_CACHE_PLANE], sideMaxY, wy, x0, x1, z0, z1, color, packedFaceLight(view, hasSkyLight, 'north', wx, wy, wz));
              if (exteriorSouth) addLodSide(acc, 'south', shape, shapes[southIndex], shapes[southIndex + LOD_CACHE_PLANE], sideMaxY, wy, x0, x1, z0, z1, color, packedFaceLight(view, hasSkyLight, 'south', wx, wy, wz));
              if (exteriorWest) addLodSide(acc, 'west', shape, shapes[westIndex], shapes[westIndex + LOD_CACHE_PLANE], sideMaxY, wy, x0, x1, z0, z1, color, packedFaceLight(view, hasSkyLight, 'west', wx, wy, wz));
              if (exteriorEast) addLodSide(acc, 'east', shape, shapes[eastIndex], shapes[eastIndex + LOD_CACHE_PLANE], sideMaxY, wy, x0, x1, z0, z1, color, packedFaceLight(view, hasSkyLight, 'east', wx, wy, wz));
            }
          }
        }
      }
    }
  }

  if (acc.empty) return null;
  const builder = new LodBuilder();
  acc.flush(builder);
  return builder.build();
}
