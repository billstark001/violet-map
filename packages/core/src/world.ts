import { toLongs, toBytes } from './binary.js';
import { BlockStateRef, normalizeId } from '@violet-map/core/domain';

const HEIGHTMAP_VALUES = 16 * 16;
const MAX_HEIGHTMAP_BITS = 16;

export const AIR: BlockStateRef = Object.freeze({ name: 'minecraft:air', properties: {} });
export const AIR_NAMES = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);

/** The small NBT subset needed by resource-driven renderers. Keeping the
 * original compound lets resource registrations grow without a parser change. */
export interface WorldEntityRecord {
  id: string;
  x: number;
  y: number;
  z: number;
  data: Record<string, unknown>;
  yaw?: number;
}

/** 1.16+ 紧凑位数组（值不跨 long）。 */
export class BitArray {
  private readonly valuesPerLong: number;
  private readonly mask: bigint;
  constructor(
    readonly bits: number,
    readonly data: BigUint64Array,
  ) {
    if (!Number.isSafeInteger(bits) || bits < 1 || bits > 64)
      throw new RangeError(`bits must be an integer from 1 to 64, got ${bits}`);
    this.valuesPerLong = Math.floor(64 / bits);
    this.mask = (1n << BigInt(bits)) - 1n;
  }
  get(index: number): number {
    const l = Math.floor(index / this.valuesPerLong);
    const shift = BigInt((index - l * this.valuesPerLong) * this.bits);
    return Number(((this.data[l] ?? 0n) >> shift) & this.mask);
  }

  /** Decode non-spanning packed values into an existing zero-initialized array. */
  copyTo(out: Uint8Array | Uint16Array): void {
    const shift = BigInt(this.bits);
    let index = 0;
    for (const packed of this.data) {
      let remaining = packed;
      for (let n = 0; n < this.valuesPerLong && index < out.length; n++) {
        out[index++] = Number(remaining & this.mask);
        remaining >>= shift;
      }
      if (index === out.length) break;
    }
  }
}

function unpackNibbles(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4096);
  for (let i = 0; i < 4096; i++) out[i] = i & 1 ? bytes[i >> 1] >> 4 : bytes[i >> 1] & 0xf;
  return out;
}

export class ChunkSection {
  private blockIndices: Uint8Array | Uint16Array | null = null;
  private biomeIndices: Uint8Array | Uint16Array | null = null;

  constructor(
    readonly y: number,
    readonly palette: BlockStateRef[],
    private states: BitArray | null,
    readonly biomePalette: string[],
    private biomeStates: BitArray | null,
    public blockLight: Uint8Array | null,
    public skyLight: Uint8Array | null,
  ) {}
  get isEmpty(): boolean {
    return this.palette.length === 1 && AIR_NAMES.has(this.palette[0].name);
  }
  blockIndex(x: number, y: number, z: number): number {
    const idx = (y << 8) | (z << 4) | x;
    if (this.blockIndices) return this.blockIndices[idx] ?? 0;
    if (!this.states) return 0;
    if (!this.blockIndices) {
      const out = this.palette.length <= 256 ? new Uint8Array(4096) : new Uint16Array(4096);
      this.states.copyTo(out);
      this.blockIndices = out;
      this.states = null;
    }
    return this.blockIndices[idx] ?? 0;
  }
  block(x: number, y: number, z: number): BlockStateRef {
    return this.palette[this.blockIndex(x, y, z)] ?? AIR;
  }
  biomeIndex(x: number, y: number, z: number): number {
    const idx = ((y >> 2) << 4) | ((z >> 2) << 2) | (x >> 2);
    if (this.biomeIndices) return this.biomeIndices[idx] ?? 0;
    if (!this.biomeStates) return 0;
    if (!this.biomeIndices) {
      const out = this.biomePalette.length <= 256 ? new Uint8Array(64) : new Uint16Array(64);
      this.biomeStates.copyTo(out);
      this.biomeIndices = out;
      this.biomeStates = null;
    }
    return this.biomeIndices[idx] ?? 0;
  }
  biome(x: number, y: number, z: number): string {
    return this.biomePalette[this.biomeIndex(x, y, z)] ?? 'minecraft:plains';
  }
}

/** Parsed chunk data with sparse section storage and lazy palette decoding. */
export class ChunkColumn {
  readonly sections = new Map<number, ChunkSection>();
  private readonly scannedHeights = new Int32Array(16 * 16);
  private readonly scannedHeightValid = new Uint8Array(16 * 16);
  minSectionY = 0;
  maxSectionY = -1;
  heightMap: BitArray | null = null;
  heightMapOffset = 0;
  hasStoredLight = false;
  hasStoredBlockLight = false;
  hasStoredSkyLight = false;
  readonly blockEntities: WorldEntityRecord[] = [];
  readonly entities: WorldEntityRecord[] = [];
  constructor(
    readonly x: number,
    readonly z: number,
  ) {}

  get minY() {
    return this.minSectionY * 16;
  }
  get maxY() {
    return (this.maxSectionY + 1) * 16;
  }

  section(y: number) {
    return this.sections.get(y >> 4);
  }

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
    const index = ((z & 15) << 4) | (x & 15);
    if (this.scannedHeightValid[index]) return this.scannedHeights[index];
    for (let y = this.maxY - 1; y >= this.minY; y--) {
      if (!AIR_NAMES.has(this.getBlock(x, y, z).name)) {
        const height = y + 1;
        this.scannedHeights[index] = height;
        this.scannedHeightValid[index] = 1;
        return height;
      }
    }
    this.scannedHeights[index] = this.minY;
    this.scannedHeightValid[index] = 1;
    return this.minY;
  }
  /** 最高非空气方块上方一格的 y（无方块返回 minY）。 */
  heightAt(x: number, z: number): number {
    if (this.heightMap) return this.heightMap.get(((z & 15) << 4) | (x & 15)) + this.heightMapOffset;
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

function numberAt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function listValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseEntityRecord(value: unknown, blockEntity: boolean): WorldEntityRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const rawId = data.id ?? data.Id;
  if (typeof rawId !== 'string' || !rawId) return null;
  const pos = listValue(data.Pos ?? data.pos);
  const x = numberAt(data.x ?? data.X) ?? numberAt(pos[0]);
  const y = numberAt(data.y ?? data.Y) ?? numberAt(pos[1]);
  const z = numberAt(data.z ?? data.Z) ?? numberAt(pos[2]);
  if (x === undefined || y === undefined || z === undefined) return null;
  const rotation = listValue(data.Rotation ?? data.rotation);
  const yaw = numberAt(rotation[0]);
  return {
    id: normalizeId(rawId),
    // Block entities are stored on integer block coordinates. Entities retain
    // their sub-block position exactly as saved.
    x: blockEntity ? Math.floor(x) : x,
    y: blockEntity ? Math.floor(y) : y,
    z: blockEntity ? Math.floor(z) : z,
    data,
    ...(yaw === undefined ? {} : { yaw }),
  };
}

function appendEntityRecords(target: WorldEntityRecord[], value: unknown, blockEntity: boolean) {
  for (const entry of listValue(value)) {
    const object = parseEntityRecord(entry, blockEntity);
    if (object) target.push(object);
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

function calibrateHeightMap(col: ChunkColumn, minSectionY: unknown): number {
  if (!col.heightMap) return Infinity;
  const offsets = Array.from(new Set([0, 1, col.minY, col.minY + 1]));
  if (Number.isSafeInteger(minSectionY)) offsets.push((minSectionY as number) * 16);
  const samples: [number, number][] = [
    [0, 0],
    [4, 4],
    [8, 8],
    [12, 12],
    [15, 15],
    [0, 15],
    [15, 0],
    [8, 3],
    [3, 8],
  ];
  let bestOffset = 0;
  let bestScore = Infinity;
  for (const offset of offsets) {
    let score = 0;
    for (const [x, z] of samples) {
      const raw = col.heightMap.get((z << 4) | x);
      score += Math.min(64, Math.abs(raw + offset - col.scanHeightAt(x, z)));
    }
    if (score < bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }
  col.heightMapOffset = bestOffset;
  return bestScore;
}

/** Infer non-spanning packing from record length, including light-only boundary
 * sections that can make the observed section range differ from build height. */
function restoreHeightMap(col: ChunkColumn, value: unknown, minSectionY: unknown): void {
  let data: BigUint64Array;
  try {
    data = toLongs(value);
  } catch {
    return;
  } // Height maps are optional acceleration; terrain remains usable.
  const guessedBits = Math.ceil(Math.log2(col.maxY - col.minY + 1));
  const candidates = Array.from({ length: MAX_HEIGHTMAP_BITS }, (_, i) => i + 1)
    .filter((bits) => Math.ceil(HEIGHTMAP_VALUES / Math.floor(64 / bits)) === data.length)
    .sort((a, b) => Math.abs(a - guessedBits) - Math.abs(b - guessedBits));
  for (const bits of candidates) {
    col.heightMap = new BitArray(bits, data);
    if (calibrateHeightMap(col, minSectionY) === 0) return;
  }
  // Fall back when sampled heights disagree or the packed length is invalid.
  col.heightMap = null;
  col.heightMapOffset = 0;
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
    if (!s || typeof s !== 'object') throw new Error('Invalid chunk section');
    const sy: number = s.Y;
    if (!Number.isInteger(sy)) throw new Error(`Invalid chunk section Y: ${String(sy)}`);
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
    if (first) {
      col.minSectionY = sy;
      col.maxSectionY = sy;
      first = false;
    } else {
      col.minSectionY = Math.min(col.minSectionY, sy);
      col.maxSectionY = Math.max(col.maxSectionY, sy);
    }
  }
  const hm = r.Heightmaps?.WORLD_SURFACE;
  if (hm && col.maxY > col.minY) restoreHeightMap(col, hm, r.yPos);
  // Names changed over time; supporting both costs little and lets modern
  // renderer resources work for legacy chunks too.
  appendEntityRecords(col.blockEntities, r.block_entities ?? r.BlockEntities ?? r.TileEntities, true);
  appendEntityRecords(col.entities, r.entities ?? r.Entities, false);
  return col;
}

/** Add entities from a modern standalone entities-region chunk. */
export function appendChunkEntities(col: ChunkColumn, root: any): void {
  const r = root.Level ?? root;
  appendEntityRecords(col.entities, r.entities ?? r.Entities, false);
}
