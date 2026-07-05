import { createHash } from 'node:crypto';
import { getRegionChunk } from '@violet-map/core/region';
import { parseNbt, decompress } from '@violet-map/core/nbt';
import { createMinimalLevelDat } from './levelDat.js';
import { cleanStoragePath, worldStorage, type StoredFileInfo } from './storage.js';

const VANILLA_DIMS: Record<string, string[]> = {
  'minecraft:overworld': ['region', 'dimensions/minecraft/overworld/region'],
  'minecraft:the_nether': ['DIM-1/region', 'dimensions/minecraft/the_nether/region'],
  'minecraft:the_end': ['DIM1/region', 'dimensions/minecraft/the_end/region'],
};
const DEFAULT_DIMS = ['minecraft:overworld'];
const WORLD_RE = /^[A-Za-z0-9_.-]+$/;
const REGION_RE = /^r\.(-?\d+)\.(-?\d+)\.mca$/;

export interface WorldInfo { id: string; dimensions: string[] }
export interface WorldFileManifestEntry {
  path: string;
  size: number;
  modifiedAt?: number;
  etag?: string;
  hash: string;
}
export interface ChunkMetadata {
  cx: number;
  cz: number;
  hash?: string;
  fileHash?: string;
  nbtHash?: string;
  source?: 'region' | 'chunk';
  sourcePath?: string;
  region?: { x: number; z: number };
  missing?: boolean;
}
export interface ChunkReadResult extends ChunkMetadata {
  data: Uint8Array;
  hash: string;
  fileHash: string;
  source: 'region' | 'chunk';
  sourcePath: string;
}

interface WorldMeta {
  id: string;
  dimensions: string[];
  createdAt: string;
  updatedAt: string;
}

interface HashCacheEntry {
  validator: string;
  hash: string;
}

interface RegionCacheEntry {
  validator: string;
  hash: string;
  bytes: Uint8Array;
}

interface ChunkCacheEntry {
  sourcePath: string;
  fileHash: string;
  data: Uint8Array;
  nbtHash: string;
}

const fileHashCache = new Map<string, HashCacheEntry>();
const regionCache = new Map<string, RegionCacheEntry>();
const chunkNbtCache = new Map<string, ChunkCacheEntry>();
const MAX_REGION_CACHE = 16;
const MAX_CHUNK_NBT_CACHE = 512;

export function assertWorldName(world: string) {
  if (!WORLD_RE.test(world)) throw new Error('invalid world name');
}

const dimDirName = (dim: string) => encodeURIComponent(dim);
const chunkCacheKey = (world: string, dim: string, cx: number, cz: number) => `${world}|${dim}|${cx},${cz}`;
const levelDatPath = (world: string) => `${world}/level.dat`;
const worldMetaPath = (world: string) => `${world}/.violet-map/world.json`;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validator(info: StoredFileInfo): string {
  return `${info.size}:${info.modifiedAt ?? ''}:${info.etag ?? ''}`;
}

function rememberLru<K, V>(map: Map<K, V>, key: K, value: V, max: number): V {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value!);
  return value;
}

function invalidatePath(filePath: string) {
  const clean = cleanStoragePath(filePath);
  fileHashCache.delete(clean);
  regionCache.delete(clean);
  for (const [key, entry] of chunkNbtCache) {
    if (entry.sourcePath === clean) chunkNbtCache.delete(key);
  }
}

function clearChunkCacheFor(world: string, dim?: string) {
  const prefix = dim ? `${world}|${dim}|` : `${world}|`;
  for (const key of chunkNbtCache.keys()) {
    if (key.startsWith(prefix)) chunkNbtCache.delete(key);
  }
}

async function hashFileInfo(info: StoredFileInfo): Promise<string> {
  const clean = cleanStoragePath(info.path);
  const v = validator(info);
  const hit = fileHashCache.get(clean);
  if (hit?.validator === v) return hit.hash;
  const bytes = await worldStorage.read(clean);
  if (!bytes) throw new Error(`file disappeared while hashing: ${clean}`);
  const hash = sha256(bytes);
  fileHashCache.set(clean, { validator: v, hash });
  return hash;
}

function dimensionRegionCandidates(dim: string): string[] {
  if (VANILLA_DIMS[dim]) return VANILLA_DIMS[dim];
  const [namespace, rawPath = ''] = dim.includes(':') ? dim.split(':') : ['minecraft', dim];
  const dimPath = rawPath.split('/').map(encodeURIComponent).join('/');
  return [`dimensions/${encodeURIComponent(namespace)}/${dimPath}/region`];
}

async function prefixHasRegionFiles(prefix: string): Promise<boolean> {
  const files = await worldStorage.list(prefix);
  return files.some((f) => REGION_RE.test(f.path.split('/').pop() ?? ''));
}

async function regionDir(world: string, dim: string): Promise<string> {
  assertWorldName(world);
  const candidates = dimensionRegionCandidates(dim).map((sub) => `${world}/${sub}`);
  for (const candidate of candidates) {
    if (await prefixHasRegionFiles(candidate)) return candidate;
  }
  return candidates[0];
}

function chunkOverrideDir(world: string, dim: string): string {
  assertWorldName(world);
  return `${world}/chunks/${dimDirName(dim)}`;
}

function regionPathFromDir(dir: string, rx: number, rz: number): string {
  return `${dir}/r.${rx}.${rz}.mca`;
}

function hasRegionChunk(region: Uint8Array, localX: number, localZ: number): boolean {
  if (region.length < 8192) return false;
  const view = new DataView(region.buffer, region.byteOffset, region.byteLength);
  const idx = (localX & 31) + ((localZ & 31) << 5);
  const loc = view.getUint32(idx * 4);
  return (loc >>> 8) !== 0 && (loc & 0xff) !== 0;
}

function clearRegionChunkEntries(region: Uint8Array, locals: { localX: number; localZ: number }[]): Uint8Array {
  const out = region.slice();
  for (const { localX, localZ } of locals) {
    const idx = (localX & 31) + ((localZ & 31) << 5);
    out.fill(0, idx * 4, idx * 4 + 4);
    out.fill(0, 4096 + idx * 4, 4096 + idx * 4 + 4);
  }
  return out;
}

async function readRegionFile(filePath: string): Promise<RegionCacheEntry | null> {
  const info = await worldStorage.stat(filePath);
  if (!info) return null;
  const clean = cleanStoragePath(filePath);
  const v = validator(info);
  const hit = regionCache.get(clean);
  if (hit?.validator === v) {
    regionCache.delete(clean);
    regionCache.set(clean, hit);
    return hit;
  }
  const bytes = await worldStorage.read(clean);
  if (!bytes) return null;
  const hash = sha256(bytes);
  fileHashCache.set(clean, { validator: v, hash });
  return rememberLru(regionCache, clean, { validator: v, hash, bytes }, MAX_REGION_CACHE);
}

async function readJson<T>(filePath: string): Promise<T | null> {
  const bytes = await worldStorage.read(filePath);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await worldStorage.write(filePath, new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`), 'application/json');
  invalidatePath(filePath);
}

async function writeWorldMeta(world: string, dimensions = DEFAULT_DIMS): Promise<void> {
  const now = new Date().toISOString();
  const previous = await readJson<WorldMeta>(worldMetaPath(world));
  const unique = [...new Set([...(previous?.dimensions ?? []), ...dimensions])];
  await writeJson(worldMetaPath(world), {
    id: world,
    dimensions: unique.length ? unique : DEFAULT_DIMS,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  } satisfies WorldMeta);
}

export async function ensureLevelDat(world: string, levelName = world, dimensions = DEFAULT_DIMS): Promise<void> {
  assertWorldName(world);
  if (!(await worldStorage.stat(levelDatPath(world)))) {
    await worldStorage.write(levelDatPath(world), createMinimalLevelDat({ levelName }), 'application/octet-stream');
    invalidatePath(levelDatPath(world));
  }
  await writeWorldMeta(world, dimensions);
}

function addDimensionFromPath(rest: string[], dims: Set<string>) {
  if (rest[0] === 'region' && REGION_RE.test(rest.at(-1) ?? '')) dims.add('minecraft:overworld');
  else if (rest[0] === 'DIM-1' && rest[1] === 'region' && REGION_RE.test(rest.at(-1) ?? '')) dims.add('minecraft:the_nether');
  else if (rest[0] === 'DIM1' && rest[1] === 'region' && REGION_RE.test(rest.at(-1) ?? '')) dims.add('minecraft:the_end');
  else if (rest[0] === 'chunks' && rest[1]) dims.add(decodeURIComponent(rest[1]));
  else if (rest[0] === 'dimensions' && rest.length >= 5) {
    const regionIndex = rest.indexOf('region');
    if (regionIndex > 2 && REGION_RE.test(rest.at(-1) ?? '')) {
      const namespace = decodeURIComponent(rest[1]);
      const dimPath = rest.slice(2, regionIndex).map(decodeURIComponent).join('/');
      dims.add(`${namespace}:${dimPath}`);
    }
  }
}

export async function listWorlds(): Promise<WorldInfo[]> {
  const byWorld = new Map<string, Set<string>>();
  for (const world of await worldStorage.listDirectories()) {
    if (!WORLD_RE.test(world)) continue;
    const dims = new Set<string>();
    const meta = await readJson<WorldMeta>(worldMetaPath(world));
    for (const dim of meta?.dimensions ?? []) dims.add(dim);
    if (await worldStorage.stat(levelDatPath(world))) {
      for (const dim of meta?.dimensions ?? DEFAULT_DIMS) dims.add(dim);
    }
    for (const dim of Object.keys(VANILLA_DIMS)) {
      if (await prefixHasRegionFiles(`${world}/${dimensionRegionCandidates(dim)[0]}`)) dims.add(dim);
      else {
        const [, modern] = dimensionRegionCandidates(dim);
        if (modern && await prefixHasRegionFiles(`${world}/${modern}`)) dims.add(dim);
      }
    }
    try {
      for (const chunkDim of await worldStorage.listDirectories(`${world}/chunks`)) {
        dims.add(decodeURIComponent(chunkDim));
      }
    } catch {
      // Optional chunk override directory.
    }
    try {
      for (const file of await worldStorage.list(`${world}/dimensions`)) {
        addDimensionFromPath(file.path.split('/').slice(1), dims);
      }
    } catch {
      // Optional modern custom dimensions directory.
    }
    if (dims.size) byWorld.set(world, dims);
  }
  return [...byWorld.entries()]
    .map(([id, dimensions]) => ({ id, dimensions: [...dimensions].sort() }))
    .filter((w) => w.dimensions.length > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function listRegions(world: string, dim: string): Promise<{ x: number; z: number }[]> {
  const out = new Map<string, { x: number; z: number }>();
  for (const sub of dimensionRegionCandidates(dim)) {
    for (const file of await worldStorage.list(`${world}/${sub}`)) {
      const match = REGION_RE.exec(file.path.split('/').pop() ?? '');
      if (!match) continue;
      const item = { x: Number(match[1]), z: Number(match[2]) };
      out.set(`${item.x},${item.z}`, item);
    }
  }
  return [...out.values()].sort((a, b) => a.x - b.x || a.z - b.z);
}

export async function getChunkMetadata(world: string, dim: string, cx: number, cz: number): Promise<ChunkMetadata> {
  const chunkPath = `${chunkOverrideDir(world, dim)}/c.${cx}.${cz}.nbt`;
  const chunkInfo = await worldStorage.stat(chunkPath);
  if (chunkInfo) {
    const fileHash = await hashFileInfo(chunkInfo);
    return { cx, cz, hash: fileHash, fileHash, source: 'chunk', sourcePath: chunkPath };
  }

  const rx = cx >> 5;
  const rz = cz >> 5;
  const filePath = regionPathFromDir(await regionDir(world, dim), rx, rz);
  const region = await readRegionFile(filePath);
  if (!region || !hasRegionChunk(region.bytes, cx & 31, cz & 31)) return { cx, cz, missing: true };
  return {
    cx,
    cz,
    hash: region.hash,
    fileHash: region.hash,
    source: 'region',
    sourcePath: filePath,
    region: { x: rx, z: rz },
  };
}

export async function getChunkNbtWithMeta(world: string, dim: string, cx: number, cz: number): Promise<ChunkReadResult | null> {
  const meta = await getChunkMetadata(world, dim, cx, cz);
  if (!meta.hash || !meta.fileHash || !meta.source || !meta.sourcePath || meta.missing) return null;

  const cacheKey = chunkCacheKey(world, dim, cx, cz);
  const hit = chunkNbtCache.get(cacheKey);
  if (hit?.sourcePath === meta.sourcePath && hit.fileHash === meta.fileHash) {
    chunkNbtCache.delete(cacheKey);
    chunkNbtCache.set(cacheKey, hit);
    return { ...meta, data: hit.data, nbtHash: hit.nbtHash } as ChunkReadResult;
  }

  let data: Uint8Array | null = null;
  if (meta.source === 'chunk') {
    const bytes = await worldStorage.read(meta.sourcePath);
    data = bytes ? decompress(bytes) : null;
  } else {
    const region = await readRegionFile(meta.sourcePath);
    data = region ? getRegionChunk(region.bytes, cx & 31, cz & 31) : null;
  }
  if (!data) return null;
  const nbtHash = sha256(data);
  rememberLru(chunkNbtCache, cacheKey, { sourcePath: meta.sourcePath, fileHash: meta.fileHash, data, nbtHash }, MAX_CHUNK_NBT_CACHE);
  return { ...meta, data, nbtHash } as ChunkReadResult;
}

/** 取一个区块的未压缩 NBT。保留给旧调用点。 */
export async function getChunkNbt(world: string, dim: string, cx: number, cz: number): Promise<Uint8Array | null> {
  return (await getChunkNbtWithMeta(world, dim, cx, cz))?.data ?? null;
}

export async function saveRegionFile(world: string, dim: string, name: string, bytes: Uint8Array): Promise<void> {
  if (!REGION_RE.test(name)) throw new Error('invalid region file name');
  const dir = await regionDir(world, dim);
  const filePath = `${dir}/${name}`;
  await worldStorage.write(filePath, bytes, 'application/octet-stream');
  invalidatePath(filePath);
  clearChunkCacheFor(world, dim);
  await ensureLevelDat(world, world, [dim]);
}

export async function saveChunkNbt(world: string, dim: string, bytes: Uint8Array): Promise<{ x: number; z: number }> {
  const root = parseNbt(bytes);
  const r = root.Level ?? root;
  const x = r.xPos, z = r.zPos;
  if (typeof x !== 'number' || typeof z !== 'number') throw new Error('chunk NBT missing xPos/zPos');
  const data = decompress(bytes);
  const filePath = `${chunkOverrideDir(world, dim)}/c.${x}.${z}.nbt`;
  await worldStorage.write(filePath, data, 'application/octet-stream');
  invalidatePath(filePath);
  rememberLru(chunkNbtCache, chunkCacheKey(world, dim, x, z), {
    sourcePath: filePath,
    fileHash: sha256(data),
    data,
    nbtHash: sha256(data),
  }, MAX_CHUNK_NBT_CACHE);
  await ensureLevelDat(world, world, [dim]);
  return { x, z };
}

export async function createWorld(world: string, dimensions = DEFAULT_DIMS, levelName = world): Promise<WorldInfo> {
  await ensureLevelDat(world, levelName, dimensions);
  return { id: world, dimensions };
}

export async function deleteWorld(world: string): Promise<{ deleted: number }> {
  assertWorldName(world);
  const deleted = await worldStorage.deletePrefix(world);
  clearChunkCacheFor(world);
  return { deleted };
}

export async function deleteRegion(world: string, dim: string, rx: number, rz: number): Promise<{ deleted: boolean }> {
  const filePath = regionPathFromDir(await regionDir(world, dim), rx, rz);
  const existed = !!(await worldStorage.stat(filePath));
  await worldStorage.delete(filePath);
  invalidatePath(filePath);
  clearChunkCacheFor(world, dim);
  return { deleted: existed };
}

export async function deleteChunks(
  world: string,
  dim: string,
  chunks: { cx: number; cz: number }[],
): Promise<{ deletedOverrides: number; clearedRegionChunks: number }> {
  let deletedOverrides = 0;
  let clearedRegionChunks = 0;
  const byRegion = new Map<string, { filePath: string; locals: { localX: number; localZ: number }[] }>();

  for (const { cx, cz } of chunks) {
    if (!Number.isInteger(cx) || !Number.isInteger(cz)) continue;
    const overridePath = `${chunkOverrideDir(world, dim)}/c.${cx}.${cz}.nbt`;
    if (await worldStorage.stat(overridePath)) {
      await worldStorage.delete(overridePath);
      invalidatePath(overridePath);
      deletedOverrides++;
    }
    const rx = cx >> 5;
    const rz = cz >> 5;
    const filePath = regionPathFromDir(await regionDir(world, dim), rx, rz);
    const key = `${rx},${rz}`;
    const group = byRegion.get(key) ?? { filePath, locals: [] };
    group.locals.push({ localX: cx & 31, localZ: cz & 31 });
    byRegion.set(key, group);
  }

  for (const { filePath, locals } of byRegion.values()) {
    const region = await readRegionFile(filePath);
    if (!region) continue;
    const present = locals.filter((p) => hasRegionChunk(region.bytes, p.localX, p.localZ));
    if (!present.length) continue;
    await worldStorage.write(filePath, clearRegionChunkEntries(region.bytes, present), 'application/octet-stream');
    invalidatePath(filePath);
    clearedRegionChunks += present.length;
  }

  clearChunkCacheFor(world, dim);
  return { deletedOverrides, clearedRegionChunks };
}

export async function saveWorldFile(world: string, relativePath: string, bytes: Uint8Array): Promise<WorldFileManifestEntry> {
  assertWorldName(world);
  const cleanRel = cleanStoragePath(relativePath);
  if (!cleanRel) throw new Error('missing file path');
  const fullPath = `${world}/${cleanRel}`;
  await worldStorage.write(fullPath, bytes, 'application/octet-stream');
  invalidatePath(fullPath);
  await ensureLevelDat(world, world);
  const info = await worldStorage.stat(fullPath);
  if (!info) throw new Error('uploaded file is not readable');
  return { ...info, path: cleanRel, hash: await hashFileInfo(info) };
}

export async function worldManifest(world: string): Promise<WorldFileManifestEntry[]> {
  assertWorldName(world);
  const prefix = `${world}/`;
  const files = await worldStorage.list(prefix);
  return Promise.all(files.map(async (file) => ({
    path: file.path.slice(prefix.length),
    size: file.size,
    modifiedAt: file.modifiedAt,
    etag: file.etag,
    hash: await hashFileInfo(file),
  })));
}

export async function diffWorldManifest(
  world: string,
  files: { path: string; hash?: string; size?: number }[],
): Promise<{ upload: string[]; same: string[]; remoteExtra: string[] }> {
  const remote = await worldManifest(world);
  const remoteByPath = new Map(remote.map((f) => [f.path, f]));
  const wanted = new Set<string>();
  const upload: string[] = [];
  const same: string[] = [];
  for (const file of files) {
    const clean = cleanStoragePath(file.path);
    wanted.add(clean);
    const current = remoteByPath.get(clean);
    if (!current || (file.hash && file.hash !== current.hash) || (file.size !== undefined && file.size !== current.size)) {
      upload.push(clean);
    } else {
      same.push(clean);
    }
  }
  const remoteExtra = remote.map((f) => f.path).filter((p) => !wanted.has(p));
  return { upload, same, remoteExtra };
}
