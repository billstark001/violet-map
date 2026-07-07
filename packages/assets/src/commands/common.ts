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
  MISSING_TEXTURE,
  ModelBaker,
  normalizeId,
  computeColumnLight,
  hexToRgb,
  meshLodChunk,
  meshSection,
  parseChunkColumn,
  resolveBiomeColors,
  type AssetBundle,
  type BiomeMap,
  type BlockModelJson,
  type AtlasIndex,
  type BlockInfo,
  type BlockInfoMap,
  type BlockStateRef,
  type MesherResources,
  type MeshBuffers,
  type ResolvedBiomeColors,
  type Rgb,
  type SectionMeshes,
  type TintType,
} from '@violet-map/core';
import { parseNbt } from '@violet-map/core/nbt';
import { iterateRegionChunks } from '@violet-map/core/region';
import minecraftData from 'minecraft-data';
import { PNG } from 'pngjs';

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
type BiomeColorMap = Record<string, ResolvedBiomeColors>;

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

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function redstoneTint(state?: BlockStateRef): Rgb {
  const power = Math.min(15, Math.max(0, Number(state?.properties.power ?? '0') || 0));
  const f = power / 15;
  return [
    power === 0 ? 0.3 : f * 0.6 + 0.4,
    clamp01(f * f * 0.7 - 0.5),
    clamp01(f * f * 0.6 - 0.7),
  ];
}

function stemTint(state?: BlockStateRef): Rgb {
  const age = Math.min(7, Math.max(0, Number(state?.properties.age ?? '0') || 0));
  return [age * 32 / 255, (255 - age * 8) / 255, age * 4 / 255];
}

export function tintOf(
  type: TintType,
  fixed: number | undefined,
  biome = 'minecraft:plains',
  biomeColors?: BiomeColorMap | null,
  state?: BlockStateRef,
): Rgb {
  if (fixed !== undefined) return hexToRgb(fixed);
  if (type === 'redstone') return redstoneTint(state);
  if (type === 'stem') return stemTint(state);
  if (type === 'attachedStem') return hexToRgb(0xe0c71c);
  const resolved = biomeColors?.[biome] ?? biomeColors?.default ?? biomeColors?.['minecraft:plains'];
  if (resolved) {
    if (type === 'grass') return resolved.grass;
    if (type === 'foliage') return resolved.foliage;
    if (type === 'water') return resolved.water;
  }
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

function stateKey(state: BlockStateRef): string {
  const keys = Object.keys(state.properties).sort();
  return `${state.name}[${keys.map((k) => `${k}=${state.properties[k]}`).join(',')}]`;
}

function textureIdForPath(namespace: string, rel: string): string {
  return `${namespace}:${rel.slice(0, -4)}`;
}

function splitAssetDirs(value: string | undefined): string[] {
  return (value ?? '').split(',').map((p) => p.trim()).filter(Boolean).map((p) => resolvePath(p));
}

export function resolveAssetDirs(value?: string): string[] {
  const explicit = splitAssetDirs(value);
  if (explicit.length) return explicit;
  const env = splitAssetDirs(process.env.ASSETS_DIRS);
  if (env.length) return env;
  return [resolvePath('packages/server/data/assets')];
}

function averagePngColor(bytes: Uint8Array): Rgb | null {
  try {
    const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      const alpha = png.data[i + 3];
      if (alpha < 32) continue;
      r += png.data[i];
      g += png.data[i + 1];
      b += png.data[i + 2];
      n++;
    }
    return n ? [r / n / 255, g / n / 255, b / n / 255] : null;
  } catch {
    return null;
  }
}

async function readTextureAverageColors(assetDirs: string[]): Promise<Map<string, Rgb>> {
  const colors = new Map<string, Rgb>();
  for (const dir of assetDirs.map((d) => resolvePath(d))) {
    let namespaces: string[] = [];
    try {
      namespaces = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue;
    }
    for (const ns of namespaces) {
      await readPngTree(path.join(dir, ns, 'textures'), async (rel, file) => {
        const avg = averagePngColor(await fs.readFile(file));
        if (avg) colors.set(textureIdForPath(ns, rel), avg);
      });
    }
  }
  return colors;
}

async function readPngTree(dir: string, onFile: (rel: string, file: string) => Promise<void>, rel = ''): Promise<void> {
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
      await readPngTree(file, onFile, childRel);
    } else if (entry.isFile() && entry.name.endsWith('.png')) {
      await onFile(childRel, file);
    }
  }));
}

function dataFileCandidates(name: string, explicit?: string): string[] {
  if (explicit) return [resolvePath(explicit)];
  const out: string[] = [];
  const dataDir = process.env.DATA_DIR ? resolvePath(process.env.DATA_DIR) : null;
  const version = process.env.MC_VERSION;
  if (dataDir && version) out.push(path.join(dataDir, 'versions', version, name));
  if (dataDir) out.push(path.join(dataDir, name));
  if (version) out.push(path.join(REPO_ROOT, 'packages/server/data-defaults/versions', version, name));
  out.push(path.join(REPO_ROOT, 'packages/server/data-defaults', name));
  return out;
}

async function readJsonFirst<T>(candidates: string[]): Promise<T | null> {
  for (const file of candidates) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as T;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function readColormapFromAssets(assetDirs: string[], name: string): Promise<Uint8Array | null> {
  for (const dir of assetDirs.map((d) => resolvePath(d))) {
    const file = path.join(dir, 'minecraft/textures/colormap', `${name}.png`);
    try {
      const png = PNG.sync.read(await fs.readFile(file));
      if (png.width !== 256 || png.height !== 256) continue;
      return Uint8Array.from(png.data);
    } catch {
      // Try the next asset directory.
    }
  }
  return null;
}

export async function loadBiomeColors(assetDirs: string[], biomesFile?: string): Promise<BiomeColorMap | null> {
  const biomes = await readJsonFirst<BiomeMap>(dataFileCandidates('biomes.json', biomesFile));
  if (!biomes) return null;
  const [grass, foliage] = await Promise.all([
    readColormapFromAssets(assetDirs, 'grass'),
    readColormapFromAssets(assetDirs, 'foliage'),
  ]);
  return resolveBiomeColors(biomes, grass, foliage);
}

function inferredTint(state: BlockStateRef, info: BlockInfo): TintType {
  if (info.tint !== 'none') return info.tint;
  const name = localName(state.name);
  if (name.includes('water') || name.includes('seagrass') || name.includes('kelp')) return 'water';
  if (name.includes('leaves') || name.includes('vine')) return 'foliage';
  if (name.includes('grass') || name.includes('fern')) return 'grass';
  return 'none';
}

function firstAverageTexture(textureColors: Map<string, Rgb>, ids: string[]): Rgb | null {
  for (const id of ids) {
    const avg = textureColors.get(id);
    if (avg) return avg;
  }
  return null;
}

function fallbackTexturesForBlock(name: string): string[] {
  const local = localName(name);
  const textures: string[] = [];
  if (name === 'minecraft:grass_block') textures.push('minecraft:block/grass_block_top', 'minecraft:block/grass_block_side_overlay', 'minecraft:block/grass_block_side');
  if (name === 'minecraft:podzol') textures.push('minecraft:block/podzol_top', 'minecraft:block/dirt');
  if (name === 'minecraft:mycelium') textures.push('minecraft:block/mycelium_top', 'minecraft:block/dirt');
  if (name === 'minecraft:dirt_path') textures.push('minecraft:block/dirt_path_top', 'minecraft:block/dirt');
  if (name === 'minecraft:farmland') textures.push('minecraft:block/farmland_moist', 'minecraft:block/farmland', 'minecraft:block/dirt');
  if (name === 'minecraft:short_grass' || name === 'minecraft:grass') textures.push('minecraft:block/short_grass', 'minecraft:block/grass');
  if (name === 'minecraft:tall_grass') textures.push('minecraft:block/tall_grass_top', 'minecraft:block/tall_grass_bottom', 'minecraft:block/short_grass');
  if (name === 'minecraft:fern') textures.push('minecraft:block/fern');
  if (local.endsWith('_leaves')) textures.push(`minecraft:block/${local}`);
  if (local.endsWith('_log') || local.endsWith('_stem') || local.endsWith('_hyphae')) textures.push(`minecraft:block/${local}_top`, `minecraft:block/${local}`);
  textures.push(`minecraft:block/${local}_top`, `minecraft:block/${local}`);
  return Array.from(new Set(textures));
}

function fallbackSurfaceColor(
  state: BlockStateRef,
  biome: string,
  fallbackColorOf: (state: BlockStateRef, biome: string) => Rgb,
  infoOf: (name: string) => BlockInfo,
  textureColors: Map<string, Rgb>,
  biomeColors?: BiomeColorMap | null,
): Rgb {
  const found = firstAverageTexture(textureColors, fallbackTexturesForBlock(state.name));
  if (found) {
    const info = infoOf(state.name);
    const tint = info.tint !== 'none'
      ? tintOf(info.tint, info.fixedTint, biome, biomeColors, state)
      : tintOf(inferredTint(state, info), info.fixedTint, biome, biomeColors, state);
    return [found[0] * tint[0], found[1] * tint[1], found[2] * tint[2]];
  }
  const name = localName(state.name);
  if (name.includes('water')) return tintOf('water', undefined, biome, biomeColors, state);
  if (name.includes('lava')) return [1, 0.34, 0.05];
  return fallbackColorOf(state, biome);
}

export async function makeTextureColorOf(
  assetDirs: string[],
  infoOf: (name: string) => BlockInfo,
  biomeColors?: BiomeColorMap | null,
): Promise<((state: BlockStateRef, biome: string) => Rgb) | null> {
  const bundle = await loadAssetBundleFromDirs(assetDirs);
  if (!Object.keys(bundle.blockstates).length && !Object.keys(bundle.models).length) return null;
  const textureColors = await readTextureAverageColors(assetDirs);
  if (!textureColors.size) return null;
  const baker = new ModelBaker(bundle);
  const cache = new Map<string, Rgb>();
  const fallbackColorOf = makeColorOf(infoOf);
  return (state, biome) => {
    if (AIR_NAMES.has(state.name)) return [0, 0, 0];
    const key = `${stateKey(state)}|${biomeColors ? biome : ''}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const info = infoOf(state.name);
    let color: Rgb | null = null;
    if (info.fluid) {
      const avg = textureColors.get(info.fluid.texture) ?? [1, 1, 1];
      const tint = tintOf(info.fluid.tint, undefined, biome, biomeColors, state);
      color = [avg[0] * tint[0], avg[1] * tint[1], avg[2] * tint[2]];
    } else {
      const quads = baker.getQuads(state, 0);
      const up = quads.find((q) => q.face === 'up') ?? quads[0];
      if (up && up.texture !== MISSING_TEXTURE) {
        const avg = textureColors.get(normalizeId(up.texture)) ?? textureColors.get(up.texture);
        if (avg) {
          const tint = up.tintIndex >= 0 ? tintOf(info.tint, info.fixedTint, biome, biomeColors, state) : WHITE;
          color = [avg[0] * tint[0], avg[1] * tint[1], avg[2] * tint[2]];
        }
      }
    }
    color ??= fallbackSurfaceColor(state, biome, fallbackColorOf, infoOf, textureColors, biomeColors);
    cache.set(key, color);
    return color;
  };
}

function latestSupportedMcDataVersion(): string {
  const versions = (minecraftData as any).supportedVersions?.pc as string[] | undefined;
  return versions?.[versions.length - 1] ?? '1.21.11';
}

function loadMinecraftData(version = process.env.MC_DATA_VERSION ?? process.env.MC_VERSION ?? '1.21.4') {
  try {
    const data = minecraftData(version);
    if (!data) throw new Error(`minecraft-data returned no data for ${version}`);
    return data;
  } catch (error) {
    const fallback = latestSupportedMcDataVersion();
    if (version === fallback) throw error;
    const data = minecraftData(fallback);
    if (!data) throw error;
    return data;
  }
}

function applyBlockInfoOverrides(map: BlockInfoMap, overrides: Record<string, Partial<BlockInfo>>) {
  for (const [pattern, patch] of Object.entries(overrides)) {
    if (pattern.includes('*')) {
      const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      for (const key of Object.keys(map)) if (re.test(key)) Object.assign(map[key], patch);
    } else {
      map[pattern] = {
        ...(map[pattern] ?? { occludes: false, emit: 0, filter: 0, layer: 'cutout', tint: 'none' }),
        ...patch,
      };
    }
  }
}

export async function loadBlockInfo(file?: string): Promise<BlockInfoMap | undefined> {
  if (file) return JSON.parse(await fs.readFile(resolvePath(file), 'utf8')) as BlockInfoMap;
  const data = loadMinecraftData();
  const map: BlockInfoMap = {};
  for (const block of data.blocksArray) {
    const transparent = block.transparent === true;
    map[`minecraft:${block.name}`] = {
      occludes: !transparent && block.boundingBox === 'block',
      emit: block.emitLight ?? 0,
      filter: block.filterLight ?? (transparent ? 0 : 15),
      layer: transparent ? 'cutout' : 'opaque',
      tint: 'none',
    };
  }
  const overrides = await readJsonFirst<Record<string, Partial<BlockInfo>>>(dataFileCandidates('block-overrides.json'));
  if (overrides) applyBlockInfoOverrides(map, overrides);
  return map;
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
