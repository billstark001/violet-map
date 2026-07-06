import { toLongs, toBytes } from './binary.js';
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
  private blockIndices: Uint8Array | Uint16Array | null = null;
  private biomeIndices: Uint8Array | Uint16Array | null = null;

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
  blockIndex(x: number, y: number, z: number): number {
    if (!this.states) return 0;
    const idx = (y << 8) | (z << 4) | x;
    if (!this.blockIndices) {
      const out = this.palette.length <= 256 ? new Uint8Array(4096) : new Uint16Array(4096);
      for (let i = 0; i < 4096; i++) out[i] = this.states.get(i);
      this.blockIndices = out;
    }
    return this.blockIndices[idx] ?? 0;
  }
  block(x: number, y: number, z: number): BlockStateRef {
    return this.palette[this.blockIndex(x, y, z)] ?? AIR;
  }
  biomeIndex(x: number, y: number, z: number): number {
    if (!this.biomeStates) return 0;
    const idx = ((y >> 2) << 4) | ((z >> 2) << 2) | (x >> 2);
    if (!this.biomeIndices) {
      const out = this.biomePalette.length <= 256 ? new Uint8Array(64) : new Uint16Array(64);
      for (let i = 0; i < 64; i++) out[i] = this.biomeStates.get(i);
      this.biomeIndices = out;
    }
    return this.biomeIndices[idx] ?? 0;
  }
  biome(x: number, y: number, z: number): string {
    return this.biomePalette[this.biomeIndex(x, y, z)] ?? 'minecraft:plains';
  }
}

export class ChunkColumn {
  readonly sections = new Map<number, ChunkSection>();
  minSectionY = 0;
  maxSectionY = -1;
  heightmap: BitArray | null = null;
  heightmapOffset = 0;
  hasStoredLight = false;
  hasStoredBlockLight = false;
  hasStoredSkyLight = false;
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
  scanHeightAt(x: number, z: number): number {
    for (let y = this.maxY - 1; y >= this.minY; y--) {
      if (!AIR_NAMES.has(this.getBlock(x, y, z).name)) return y + 1;
    }
    return this.minY;
  }
  /** 最高非空气方块上方一格的 y（无方块返回 minY）。 */
  heightAt(x: number, z: number): number {
    if (this.heightmap) return this.heightmap.get((z << 4) | x) + this.heightmapOffset;
    return this.scanHeightAt(x, z);
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

function hasAnyLight(a: Uint8Array | null): boolean {
  if (!a) return false;
  for (const v of a) if (v > 0) return true;
  return false;
}

function calibrateHeightmap(col: ChunkColumn) {
  if (!col.heightmap) return;
  const offsets = Array.from(new Set([0, 1, col.minY, col.minY + 1]));
  const samples: [number, number][] = [[0, 0], [4, 4], [8, 8], [12, 12], [15, 15], [0, 15], [15, 0], [8, 3], [3, 8]];
  let bestOffset = 0;
  let bestScore = Infinity;
  for (const offset of offsets) {
    let score = 0;
    for (const [x, z] of samples) {
      const raw = col.heightmap.get((z << 4) | x);
      score += Math.min(64, Math.abs(raw + offset - col.scanHeightAt(x, z)));
    }
    if (score < bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }
  col.heightmapOffset = bestOffset;
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
    if (hasAnyLight(blockLight)) col.hasStoredBlockLight = true;
    if (hasAnyLight(skyLight)) col.hasStoredSkyLight = true;

    col.sections.set(sy, new ChunkSection(sy, palette, states, biomePalette, biomeStates, blockLight, skyLight));
    if (first) { col.minSectionY = sy; col.maxSectionY = sy; first = false; }
    else { col.minSectionY = Math.min(col.minSectionY, sy); col.maxSectionY = Math.max(col.maxSectionY, sy); }
  }
  const hm = r.Heightmaps?.WORLD_SURFACE;
  if (hm) {
    const height = col.maxY - col.minY;
    if (height > 0) {
      col.heightmap = new BitArray(Math.ceil(Math.log2(height + 1)), toLongs(hm));
      calibrateHeightmap(col);
    }
  }
  return col;
}
