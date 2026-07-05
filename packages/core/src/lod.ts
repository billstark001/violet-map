import { AIR, AIR_NAMES, ChunkColumn } from './world.js';
import { BlockInfo, BlockStateRef, Direction, MeshBuffers } from './types.js';
import type { Rgb } from './colors.js';
import { Float32Writer, Uint32Writer } from './meshBufferBuilder.js';

interface LodWorldView {
  getBlock(x: number, y: number, z: number): BlockStateRef;
  getBiome(x: number, y: number, z: number): string;
  getSkyLight?(x: number, y: number, z: number): number;
}

interface LodShape {
  minY: number;
  maxY: number;
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
  count: number;
}

const DEFAULT_INFO: BlockInfo = { occludes: true, emit: 0, filter: 15, layer: 'opaque', tint: 'none' };
const SHADE: Record<Direction, number> = { up: 1, down: 0.5, north: 0.8, south: 0.8, west: 0.6, east: 0.6 };
const EPS = 1e-4;
const COORD_SCALE = 1024;

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
  uv = new Float32Writer(1024 * 2);
  col = new Float32Writer(1024 * 3);
  light = new Float32Writer(1024 * 2);
  idx = new Uint32Writer(1024 * 6);
  verts = 0;

  vertex(x: number, y: number, z: number, color: Rgb, light: [number, number], shade: number) {
    this.pos.push3(x, y, z);
    this.uv.push2(0, 0);
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
    return {
      positions: this.pos.toArray(),
      uvs: this.uv.toArray(),
      colors: this.col.toArray(),
      lights: this.light.toArray(),
      indices: this.idx.toArray(),
    };
  }
}

class LodFaceAccumulator {
  private buckets = new Map<string, FaceBucket>();

  get empty() { return this.buckets.size === 0; }

  add(
    dir: Direction,
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    z0: number,
    z1: number,
    color: Rgb,
  ) {
    if (Math.abs(x1 - x0) <= EPS && (dir === 'up' || dir === 'down' || dir === 'north' || dir === 'south')) return;
    if (Math.abs(z1 - z0) <= EPS && (dir === 'up' || dir === 'down' || dir === 'west' || dir === 'east')) return;
    if (Math.abs(y1 - y0) <= EPS && dir !== 'up' && dir !== 'down') return;

    const key = [
      dir,
      coordKey(x0),
      coordKey(x1),
      coordKey(y0),
      coordKey(y1),
      coordKey(z0),
      coordKey(z1),
    ].join('|');
    const hit = this.buckets.get(key);
    if (hit) {
      hit.r += color[0];
      hit.g += color[1];
      hit.b += color[2];
      hit.count++;
      return;
    }
    this.buckets.set(key, { dir, x0, x1, y0, y1, z0, z1, r: color[0], g: color[1], b: color[2], count: 1 });
  }

  flush(builder: LodBuilder, light: [number, number]) {
    for (const f of this.buckets.values()) {
      const color: Rgb = [f.r / f.count, f.g / f.count, f.b / f.count];
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

function coordKey(v: number): number {
  return Math.round(v * COORD_SCALE);
}

function localName(name: string): string {
  return name.includes(':') ? name.split(':')[1] : name;
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
  return maxY - minY > EPS ? { minY, maxY } : null;
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
  };
}

function quantFloor(v: number, step: number): number {
  return Math.max(0, Math.min(16, Math.floor((v + EPS) / step) * step));
}

function quantCeil(v: number, step: number): number {
  return Math.max(0, Math.min(16, Math.ceil((v - EPS) / step) * step));
}

function subtractInterval(minY: number, maxY: number, cover: LodShape | null): [number, number][] {
  if (!cover) return [[minY, maxY]];
  const c0 = Math.max(minY, cover.minY);
  const c1 = Math.min(maxY, cover.maxY);
  if (c1 <= c0 + EPS) return [[minY, maxY]];
  const out: [number, number][] = [];
  if (c0 > minY + EPS) out.push([minY, c0]);
  if (c1 < maxY - EPS) out.push([c1, maxY]);
  return out;
}

/**
 * 低 LOD：从当前区块内所有可见的简化方块面生成网格，再按 step 折叠到 x/z 网格。
 * 这比单纯 heightmap 顶面更贵一点，但能保留桥底、树冠侧面、水面/半砖高度和 LOD 交界遮挡。
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
  const s = Math.max(1, Math.floor(step));
  const view = worldView ?? makeLocalView(col);
  const acc = new LodFaceAccumulator();
  const ox = col.x * 16;
  const oz = col.z * 16;

  const neighborShape = (wx: number, wy: number, wz: number): LodShape | null => {
    const state = view.getBlock(wx, wy, wz);
    return shapeOf(state, infoOf(state.name));
  };
  const exterior = (wx: number, wy: number, wz: number): boolean => {
    if (!hasSkyLight || !view.getSkyLight) return true;
    return view.getSkyLight(wx, wy, wz) > 0;
  };

  for (const [sy, section] of col.sections) {
    if (section.isEmpty) continue;
    for (let ly = 0; ly < 16; ly++) {
      const wy = sy * 16 + ly;
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const state = section.block(x, ly, z);
          const info = infoOf(state.name);
          const shape = shapeOf(state, info);
          if (!shape) continue;

          const wx = ox + x;
          const wz = oz + z;
          const color = colorOf(state, view.getBiome(wx, wy, wz));
          const x0 = quantFloor(x, s);
          const x1 = quantCeil(x + 1, s);
          const z0 = quantFloor(z, s);
          const z1 = quantCeil(z + 1, s);
          const y0 = wy + shape.minY;
          const y1 = wy + shape.maxY;

          const above = neighborShape(wx, wy + 1, wz);
          if ((!above || above.minY > EPS) && exterior(wx, wy + 1, wz)) acc.add('up', x0, x1, y1, y1, z0, z1, color);

          const below = neighborShape(wx, wy - 1, wz);
          if ((!below || below.maxY < 1 - EPS) && exterior(wx, wy - 1, wz)) acc.add('down', x0, x1, y0, y0, z0, z1, color);

          const side = (dir: Direction, nx: number, nz: number) => {
            const cover = neighborShape(wx + nx, wy, wz + nz);
            for (const [a, b] of subtractInterval(shape.minY, shape.maxY, cover)) {
              const ay = wy + a;
              const by = wy + b;
              if (!exterior(wx + nx, Math.floor((ay + by) * 0.5), wz + nz)) continue;
              switch (dir) {
                case 'north':
                  acc.add('north', x0, x1, ay, by, quantFloor(z, s), quantFloor(z, s), color);
                  break;
                case 'south':
                  acc.add('south', x0, x1, ay, by, quantCeil(z + 1, s), quantCeil(z + 1, s), color);
                  break;
                case 'west':
                  acc.add('west', quantFloor(x, s), quantFloor(x, s), ay, by, z0, z1, color);
                  break;
                case 'east':
                  acc.add('east', quantCeil(x + 1, s), quantCeil(x + 1, s), ay, by, z0, z1, color);
                  break;
                default:
                  break;
              }
            }
          };

          side('north', 0, -1);
          side('south', 0, 1);
          side('west', -1, 0);
          side('east', 1, 0);
        }
      }
    }
  }

  if (acc.empty) return null;
  const builder = new LodBuilder();
  acc.flush(builder, hasSkyLight ? [1, 0] : [0, 1]);
  return builder.build();
}
