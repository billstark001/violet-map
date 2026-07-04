import { toLongs, toBytes } from './nbt.js';
import { BlockStateRef, normalizeId } from './types.js';

export const AIR: BlockStateRef = Object.freeze({ name: 'minecraft:air', properties: {} });
export const AIR_NAMES = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);

/** 1.16+ 紧凑位数组（值不跨 long）。 */
export class BitArray {
  private readonly valuesPerLong: number;
  private readonly mask: bigint;
  constructor(readonly bits: number, readonly data: BigUint64Array) {
    this.valuesPerLong = Math.floor(64 / bits);
    this.mask = (1n << BigInt(bits)) - 1n;
  }
  get(index: number): number {
    const l = Math.floor(index / this.valuesPerLong);
    const shift = BigInt((index - l * this.valuesPerLong) * this.bits);
    return Number((this.data[l] >> shift) & this.mask);
  }
}

function unpackNibbles(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4096);
  for (let i = 0; i < 4096; i++) out[i] = (i & 1) ? (bytes[i >> 1] >> 4) : (bytes[i >> 1] & 0xf);
  return out;
}

export class ChunkSection {
  constructor(
    readonly y: number,
    readonly palette: BlockStateRef[],
    readonly states: BitArray | null,
    readonly biomePalette: string[],
    readonly biomeStates: BitArray | null,
    public blockLight: Uint8Array | null,
    public skyLight: Uint8Array | null,
  ) {}
  get isEmpty(): boolean {
    return this.palette.length === 1 && AIR_NAMES.has(this.palette[0].name);
  }
  block(x: number, y: number, z: number): BlockStateRef {
    if (!this.states) return this.palette[0] ?? AIR;
    return this.palette[this.states.get((y << 8) | (z << 4) | x)] ?? AIR;
  }
  biome(x: number, y: number, z: number): string {
    if (!this.biomeStates) return this.biomePalette[0] ?? 'minecraft:plains';
    return this.biomePalette[this.biomeStates.get(((y >> 2) << 4) | ((z >> 2) << 2) | (x >> 2))] ?? 'minecraft:plains';
  }
}

export class ChunkColumn {
  readonly sections = new Map<number, ChunkSection>();
  minSectionY = 0;
  maxSectionY = -1;
  heightmap: BitArray | null = null;
  hasStoredLight = false;
  constructor(readonly x: number, readonly z: number) {}

  get minY() { return this.minSectionY * 16; }
  get maxY() { return (this.maxSectionY + 1) * 16; }

  section(y: number) { return this.sections.get(y >> 4); }

  getBlock(x: number, y: number, z: number): BlockStateRef {
    const s = this.section(y);
    return s ? s.block(x & 15, y & 15, z & 15) : AIR;
  }
  getBiome(x: number, y: number, z: number): string {
    const cy = Math.min(Math.max(y, this.minY), this.maxY - 1);
    const s = this.section(cy);
    return s ? s.biome(x & 15, cy & 15, z & 15) : 'minecraft:plains';
  }
  getBlockLight(x: number, y: number, z: number): number {
    const s = this.section(y);
    return s?.blockLight ? s.blockLight[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] : 0;
  }
  getSkyLight(x: number, y: number, z: number): number {
    if (y >= this.maxY) return 15;
    if (y < this.minY) return 0;
    const s = this.section(y);
    if (!s || !s.skyLight) return y >= this.heightAt(x, z) ? 15 : 0;
    return s.skyLight[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)];
  }
  /** 最高非空气方块上方一格的 y（无方块返回 minY）。 */
  heightAt(x: number, z: number): number {
    if (this.heightmap) return this.heightmap.get((z << 4) | x) + this.minY;
    for (let y = this.maxY - 1; y >= this.minY; y--) {
      if (!AIR_NAMES.has(this.getBlock(x, y, z).name)) return y + 1;
    }
    return this.minY;
  }
  /** 保证 [minSectionY, maxSectionY] 范围内每个 section 存在（光照引擎需要空气 section 承载亮度）。 */
  ensureSection(sy: number): ChunkSection {
    let s = this.sections.get(sy);
    if (!s) {
      s = new ChunkSection(sy, [AIR], null, ['minecraft:plains'], null, null, null);
      this.sections.set(sy, s);
    }
    return s;
  }
}

function parseProps(p: unknown): Record<string, string> {
  if (!p || typeof p !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) out[k] = String(v);
  return out;
}

/** 解析 1.18+ 区块 NBT（simplify 后的对象）。 */
export function parseChunkColumn(root: any): ChunkColumn {
  const r = root.Level ?? root;
  if (!Array.isArray(r.sections)) {
    throw new Error('Unsupported chunk format: expected 1.18+ ("sections" tag missing)');
  }
  const col = new ChunkColumn(r.xPos ?? 0, r.zPos ?? 0);
  let first = true;
  for (const s of r.sections) {
    const sy: number = s.Y;
    const bs = s.block_states;
    const palette: BlockStateRef[] = bs?.palette
      ? bs.palette.map((p: any) => ({ name: normalizeId(p.Name), properties: parseProps(p.Properties) }))
      : [AIR];
    const bits = Math.max(4, Math.ceil(Math.log2(palette.length)));
    const states = bs?.data ? new BitArray(bits, toLongs(bs.data)) : null;

    const biomePalette: string[] = s.biomes?.palette ? s.biomes.palette.map(normalizeId) : ['minecraft:plains'];
    const bbits = Math.max(1, Math.ceil(Math.log2(biomePalette.length)));
    const biomeStates = s.biomes?.data ? new BitArray(bbits, toLongs(s.biomes.data)) : null;

    const blockLight = s.BlockLight ? unpackNibbles(toBytes(s.BlockLight)) : null;
    const skyLight = s.SkyLight ? unpackNibbles(toBytes(s.SkyLight)) : null;
    if (blockLight || skyLight) col.hasStoredLight = true;

    col.sections.set(sy, new ChunkSection(sy, palette, states, biomePalette, biomeStates, blockLight, skyLight));
    if (first) { col.minSectionY = sy; col.maxSectionY = sy; first = false; }
    else { col.minSectionY = Math.min(col.minSectionY, sy); col.maxSectionY = Math.max(col.maxSectionY, sy); }
  }
  const hm = r.Heightmaps?.WORLD_SURFACE;
  if (hm) {
    const height = col.maxY - col.minY;
    if (height > 0) col.heightmap = new BitArray(Math.ceil(Math.log2(height + 1)), toLongs(hm));
  }
  return col;
}