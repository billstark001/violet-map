import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  AIR_NAMES,
  ChunkColumn,
  ChunkNeighborhood,
  ModelBaker,
  computeColumnLight,
  hexToRgb,
  meshLodChunk,
  meshSection,
  parseChunkColumn,
  type AssetBundle,
  type BlockModelJson,
  type AtlasIndex,
  type BlockInfo,
  type BlockInfoMap,
  type BlockStateRef,
  type MesherResources,
  type MeshBuffers,
  type Rgb,
  type SectionMeshes,
  type TintType,
} from '@violet-map/core';
import { parseNbt } from '@violet-map/core/nbt';
import { iterateRegionChunks } from '@violet-map/core/region';

export interface ArgReader {
  get(names: string | string[], fallback?: string): string | undefined;
  flag(name: string): boolean;
}

export interface ColumnEntry {
  col: ChunkColumn;
  litSky: boolean;
  litBlock: boolean;
}

export interface MeshStats {
  vertices: number;
  indices: number;
  sections: number;
}

export interface TimedMeshStats extends MeshStats {
  ms: number;
}

export interface Summary extends MeshStats {
  label: string;
  samples: number;
  totalMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface RegionFile {
  rx: number;
  rz: number;
  file: string;
}

export const DEFAULT_BLOCK_INFO: BlockInfo = { occludes: true, emit: 0, filter: 15, layer: 'opaque', tint: 'none' };
export const AIR_BLOCK_INFO: BlockInfo = { occludes: false, emit: 0, filter: 0, layer: 'cutout', tint: 'none' };
export const WHITE: Rgb = [1, 1, 1];
export const DEFAULT_RECT = { u0: 0, v0: 0, u1: 1, v1: 1 };
export const fakeAtlas = new Proxy(Object.create(null), {
  get: (_target, prop) => typeof prop === 'symbol' ? undefined : DEFAULT_RECT,
}) as AtlasIndex;

const REGION_RE = /^r\.(-?\d+)\.(-?\d+)\.mca$/;
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../..');

export function argsReader(args: string[]): ArgReader {
  return {
    get(names, fallback) {
      const all = Array.isArray(names) ? names : [names];
      for (const name of all) {
        const idx = args.indexOf(name);
        if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
      }
      return fallback;
    },
    flag(name) {
      return args.includes(name);
    },
  };
}

export function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`missing ${label}`);
  return value;
}

export function resolvePath(input: string, base = process.env.INIT_CWD ?? process.cwd()): string {
  if (path.isAbsolute(input)) return input;
  const bases = [...new Set([base, process.cwd(), REPO_ROOT])];
  for (const candidateBase of bases) {
    const candidate = path.resolve(candidateBase, input);
    if (existsSync(candidate)) return candidate;
  }
  return path.resolve(process.cwd() === PACKAGE_ROOT ? REPO_ROOT : base, input);
}

export function numberArg(value: string | undefined, fallback: number, min = -Infinity): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, n) : fallback;
}

export function parseDim(value = 'minecraft:overworld'): string {
  return value.includes(':') ? value : `minecraft:${value}`;
}

export function encodeBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

export function encodeTypedArray(values: Uint16Array | Uint32Array | Uint8Array | Int16Array): string {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString('base64');
}

export function sha1Bytes(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex');
}

export function localName(name: string): string {
  return name.includes(':') ? name.split(':')[1] : name;
}

export function hashColor(id: string): Rgb {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const r = 0.35 + ((h & 0xff) / 255) * 0.45;
  const g = 0.35 + (((h >>> 8) & 0xff) / 255) * 0.45;
  const b = 0.35 + (((h >>> 16) & 0xff) / 255) * 0.45;
  return [r, g, b];
}

export function tintOf(type: TintType, fixed: number | undefined): Rgb {
  if (fixed !== undefined) return hexToRgb(fixed);
  if (type === 'grass') return [0.48, 0.68, 0.29];
  if (type === 'foliage') return [0.36, 0.58, 0.25];
  if (type === 'water') return [0.25, 0.42, 0.95];
  return WHITE;
}

export function infoGetter(blockInfo?: BlockInfoMap): (name: string) => BlockInfo {
  return (name) => {
    if (AIR_NAMES.has(name)) return AIR_BLOCK_INFO;
    return blockInfo?.[name] ?? DEFAULT_BLOCK_INFO;
  };
}

export function stateColor(state: BlockStateRef): Rgb {
  return AIR_NAMES.has(state.name) ? [0, 0, 0] : hashColor(state.name);
}

export function makeColorOf(infoOf: (name: string) => BlockInfo): (state: BlockStateRef, biome: string) => Rgb {
  const cache = new Map<string, Rgb>();
  return (state) => {
    const hit = cache.get(state.name);
    if (hit) return hit;
    const info = infoOf(state.name);
    const tint = info.fluid ? tintOf(info.fluid.tint, undefined) : tintOf(info.tint, info.fixedTint);
    const base = info.fluid ? hashColor(info.fluid.texture) : hashColor(state.name);
    const color: Rgb = [base[0] * tint[0], base[1] * tint[1], base[2] * tint[2]];
    cache.set(state.name, color);
    return color;
  };
}

export async function loadBlockInfo(file?: string): Promise<BlockInfoMap | undefined> {
  if (!file) return undefined;
  return JSON.parse(await fs.readFile(resolvePath(file), 'utf8')) as BlockInfoMap;
}

export async function loadAssetBundleFromDirs(dirs: string[]): Promise<AssetBundle> {
  const bundle: AssetBundle = { blockstates: {}, models: {} };
  for (const dir of dirs.map((d) => resolvePath(d))) {
    let namespaces: string[] = [];
    try {
      namespaces = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const ns of namespaces) {
      await readJsonTree(path.join(dir, ns, 'blockstates'), (rel, value) => {
        bundle.blockstates[`${ns}:${rel.slice(0, -5)}`] = value;
      });
      await readJsonTree(path.join(dir, ns, 'models'), (rel, value) => {
        bundle.models[`${ns}:${rel.slice(0, -5)}`] = value as BlockModelJson;
      });
    }
  }
  return bundle;
}

async function readJsonTree(dir: string, onFile: (rel: string, value: unknown) => void, rel = ''): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries.map(async (entry) => {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await readJsonTree(file, onFile, childRel);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      try {
        onFile(childRel, JSON.parse(await fs.readFile(file, 'utf8')));
      } catch {
        // Skip malformed resource files so one bad model does not block profiling.
      }
    }
  }));
}

export async function loadRegionColumns(file: string): Promise<Map<string, ColumnEntry>> {
  const bytes = new Uint8Array(await fs.readFile(resolvePath(file)));
  const entries = new Map<string, ColumnEntry>();
  for (const chunk of iterateRegionChunks(bytes)) {
    const col = parseChunkColumn(parseNbt(chunk.data));
    entries.set(`${col.x},${col.z}`, {
      col,
      litSky: col.hasStoredSkyLight,
      litBlock: col.hasStoredBlockLight,
    });
  }
  return entries;
}

export function makeNeighborhood(entries: Map<string, ColumnEntry>, col: ChunkColumn): ChunkNeighborhood {
  const hood = new ChunkNeighborhood(col.x - 1, col.z - 1);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const entry = entries.get(`${col.x + dx},${col.z + dz}`);
      if (entry) hood.set(entry.col);
    }
  }
  return hood;
}

export function ensureLight(entry: ColumnEntry, infoOf: (name: string) => BlockInfo, hasSkyLight: boolean) {
  const needSky = hasSkyLight && !entry.litSky;
  const needBlock = !entry.litBlock;
  if (!needSky && !needBlock) return;
  computeColumnLight(entry.col, infoOf, hasSkyLight, { writeSky: needSky, writeBlock: needBlock });
  entry.litSky = entry.litSky || needSky || !hasSkyLight || entry.col.hasStoredSkyLight;
  entry.litBlock = entry.litBlock || needBlock || entry.col.hasStoredBlockLight;
}

export function meshStats(mesh: MeshBuffers | null | undefined): MeshStats {
  if (!mesh) return { vertices: 0, indices: 0, sections: 0 };
  return { vertices: mesh.positions.length / 3, indices: mesh.indices.length, sections: 1 };
}

export function sectionStats(sections: SectionMeshes): MeshStats {
  const total: MeshStats = { vertices: 0, indices: 0, sections: 0 };
  for (const mesh of Object.values(sections)) {
    total.vertices += mesh.positions.length / 3;
    total.indices += mesh.indices.length;
  }
  if (total.vertices > 0) total.sections = 1;
  return total;
}

export function addStats(a: MeshStats, b: MeshStats): MeshStats {
  a.vertices += b.vertices;
  a.indices += b.indices;
  a.sections += b.sections;
  return a;
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

export function summarize(label: string, samples: TimedMeshStats[]): Summary {
  const times = samples.map((s) => s.ms);
  const totalMs = times.reduce((a, b) => a + b, 0);
  return {
    label,
    samples: samples.length,
    totalMs,
    avgMs: totalMs / Math.max(1, samples.length),
    p50Ms: percentile(times, 0.5),
    p95Ms: percentile(times, 0.95),
    maxMs: Math.max(0, ...times),
    vertices: samples.reduce((a, b) => a + b.vertices, 0),
    indices: samples.reduce((a, b) => a + b.indices, 0),
    sections: samples.reduce((a, b) => a + b.sections, 0),
  };
}

export function formatMs(v: number): string {
  return v.toFixed(2).padStart(8);
}

export function printSummaryTable(summaries: Summary[]) {
  console.log('');
  console.log('label       samples    total      avg      p50      p95      max      verts      indices');
  console.log('----------  -------  -------  -------  -------  -------  -------  ---------  ----------');
  for (const s of summaries) {
    console.log([
      s.label.padEnd(10),
      String(s.samples).padStart(7),
      formatMs(s.totalMs),
      formatMs(s.avgMs),
      formatMs(s.p50Ms),
      formatMs(s.p95Ms),
      formatMs(s.maxMs),
      String(Math.round(s.vertices / Math.max(1, s.samples))).padStart(9),
      String(Math.round(s.indices / Math.max(1, s.samples))).padStart(10),
    ].join('  '));
  }
}

export function buildMesherResources(bundle: AssetBundle, infoOf: (name: string) => BlockInfo): MesherResources {
  const baker = new ModelBaker(bundle);
  return {
    baker,
    info: infoOf,
    tint: (type, fixed) => tintOf(type, fixed),
    atlas: fakeAtlas,
    textureHasAlpha: {},
  };
}

export function profileFullColumn(res: MesherResources, hood: ChunkNeighborhood, col: ChunkColumn): MeshStats {
  const total: MeshStats = { vertices: 0, indices: 0, sections: 0 };
  for (let sy = col.minSectionY; sy <= col.maxSectionY; sy++) {
    const section = col.sections.get(sy);
    if (!section || section.isEmpty) continue;
    addStats(total, sectionStats(meshSection(res, hood, col.x, sy, col.z).layers));
  }
  return total;
}

export function profileLodColumn(
  col: ChunkColumn,
  step: number,
  colorOf: (state: BlockStateRef, biome: string) => Rgb,
  hasSkyLight: boolean,
  hood: ChunkNeighborhood,
  infoOf: (name: string) => BlockInfo,
): MeshStats {
  return meshStats(meshLodChunk(col, step, colorOf, hasSkyLight, hood, infoOf));
}

export function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

export async function findRegionFiles(worldDir: string, dim: string): Promise<RegionFile[]> {
  const world = resolvePath(worldDir);
  const candidates = dimensionRegionDirs(world, dim);
  const out: RegionFile[] = [];
  for (const dir of candidates) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const match = REGION_RE.exec(entry.name);
      if (!match) continue;
      out.push({ rx: Number(match[1]), rz: Number(match[2]), file: path.join(dir, entry.name) });
    }
  }
  return out.sort((a, b) => a.rx - b.rx || a.rz - b.rz);
}

function dimensionRegionDirs(world: string, dim: string): string[] {
  if (dim === 'minecraft:overworld') return [path.join(world, 'region'), path.join(world, 'dimensions/minecraft/overworld/region')];
  if (dim === 'minecraft:the_nether') return [path.join(world, 'DIM-1/region'), path.join(world, 'dimensions/minecraft/the_nether/region')];
  if (dim === 'minecraft:the_end') return [path.join(world, 'DIM1/region'), path.join(world, 'dimensions/minecraft/the_end/region')];
  const [namespace, rawPath = ''] = dim.includes(':') ? dim.split(':') : ['minecraft', dim];
  return [path.join(world, 'dimensions', namespace, rawPath, 'region')];
}

export function defaultTopMapOut(worldDir: string): string {
  return path.join(resolvePath(worldDir), '.violet-map/top-map');
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function pathExists(file: string): Promise<boolean> {
  if (existsSync(file)) return true;
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
