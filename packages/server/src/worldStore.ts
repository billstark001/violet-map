import { createHash } from 'node:crypto';
import { getRegionChunk } from '@violet-map/core/region';
import { parseNbt, decompress } from '@violet-map/core/nbt';
import { createMinimalLevelDat } from './levelDat.js';
import { cleanStoragePath, worldStorage, type StoredFileInfo } from './storage.js';
import { ensureWorldIdentity, PrefixedWorldStorage } from '@violet-map/core/storage';

const VANILLA_DIMS: Record<string, string[]> = {
  'minecraft:overworld': ['region', 'dimensions/minecraft/overworld/region'],
  'minecraft:the_nether': ['DIM-1/region', 'dimensions/minecraft/the_nether/region'],
  'minecraft:the_end': ['DIM1/region', 'dimensions/minecraft/the_end/region'],
};
const DEFAULT_DIMS = ['minecraft:overworld'];
const WORLD_RE = /^[A-Za-z0-9_.-]+$/;
const REGION_RE = /^r\.(-?\d+)\.(-?\d+)\.mca$/;
const CHUNK_RE = /^c\.(-?\d+)\.(-?\d+)\.nbt$/;

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
  /** Validator for the optional modern `entities/` region chunk. */
  entityHash?: string;
  entitySourcePath?: string;
  missing?: boolean;
}
export interface ChunkReadResult extends ChunkMetadata {
  data: Uint8Array;
  entities?: Uint8Array;
  hash: string;
  fileHash: string;
  source: 'region' | 'chunk';
  sourcePath: string;
}
export interface ChunkSourceCoverage {
  regions: { x: number; z: number; mask: string }[];
  chunks: { cx: number; cz: number }[];
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

interface RegionHeaderCacheEntry {
  validator: string;
  hash: string;
  header: Uint8Array;
}

interface ChunkCacheEntry {
  sourcePath: string;
  fileHash: string;
  data: Uint8Array;
  nbtHash: string;
  entityHash?: string;
  entities?: Uint8Array;
}

const fileHashCache = new Map<string, HashCacheEntry>();
const regionCache = new Map<string, RegionCacheEntry>();
const regionHeaderCache = new Map<string, RegionHeaderCacheEntry>();
const regionReadInflight = new Map<string, Promise<RegionCacheEntry | null>>();
const regionHeaderInflight = new Map<string, Promise<RegionHeaderCacheEntry | null>>();
const regionDirCache = new Map<string, string>();
const entityDirCache = new Map<string, string>();
const chunkNbtCache = new Map<string, ChunkCacheEntry>();
const MAX_REGION_CACHE = 16;
const MAX_REGION_HEADER_CACHE = 256;
const MAX_CHUNK_NBT_CACHE = 512;
const MAX_FILE_HASH_CACHE = 4096;
const MAX_REGION_CACHE_BYTES = Number(process.env.REGION_CACHE_BYTES ?? 256 * 1024 * 1024);
const MAX_CHUNK_NBT_CACHE_BYTES = Number(process.env.CHUNK_NBT_CACHE_BYTES ?? 128 * 1024 * 1024);
const REGION_LOCATION_BYTES = 4096;
let regionCacheBytes = 0;
let chunkNbtCacheBytes = 0;
const WORLD_LIST_CACHE_MS = 15_000;
let worldListCache: { expiresAt: number; worlds: WorldInfo[] } | null = null;
let worldListInflight: Promise<WorldInfo[]> | null = null;

export function assertWorldName(world: string) {
  if (!WORLD_RE.test(world)) throw new Error('invalid world name');
}

function invalidateWorldList(): void {
  worldListCache = null;
}

const dimDirName = (dim: string) => encodeURIComponent(dim);
const chunkCacheKey = (world: string, dim: string, cx: number, cz: number) => `${world}|${dim}|${cx},${cz}`;
const levelDatPath = (world: string) => `${world}/level.dat`;
const worldMetaPath = (world: string) => `${world}/.violet-map/world.json`;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function chunkPayloadHash(data: Uint8Array, entities?: Uint8Array): string {
  const hash = createHash('sha256');
  hash.update(data);
  // Delimiters prevent an accidental equivalent concatenation of two chunks.
  hash.update(new Uint8Array([0]));
  if (entities) hash.update(entities);
  return hash.digest('hex');
}

function validator(info: StoredFileInfo): string {
  return `${info.size}:${info.modifiedAt ?? ''}:${info.etag ?? ''}`;
}

function sourceHashForInfo(info: StoredFileInfo): string {
  return `v2:${validator(info)}`;
}

function rememberLru<K, V>(map: Map<K, V>, key: K, value: V, max: number): V {
  map.delete(key);
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value!);
  return value;
}

function touchLru<K, V>(map: Map<K, V>, key: K, value: V) {
  map.delete(key);
  map.set(key, value);
}

function rememberRegionCache(key: string, value: RegionCacheEntry): RegionCacheEntry {
  const previous = regionCache.get(key);
  if (previous) regionCacheBytes -= previous.bytes.byteLength;
  touchLru(regionCache, key, value);
  regionCacheBytes += value.bytes.byteLength;
  while (regionCache.size > MAX_REGION_CACHE || regionCacheBytes > MAX_REGION_CACHE_BYTES) {
    const oldestKey = regionCache.keys().next().value;
    if (!oldestKey) break;
    deleteRegionCache(oldestKey);
  }
  return value;
}

function deleteRegionCache(key: string) {
  const hit = regionCache.get(key);
  if (!hit) return;
  regionCacheBytes -= hit.bytes.byteLength;
  regionCache.delete(key);
}

function rememberChunkNbtCache(key: string, value: ChunkCacheEntry): ChunkCacheEntry {
  const previous = chunkNbtCache.get(key);
  if (previous) chunkNbtCacheBytes -= previous.data.byteLength;
  touchLru(chunkNbtCache, key, value);
  chunkNbtCacheBytes += value.data.byteLength;
  while (chunkNbtCache.size > MAX_CHUNK_NBT_CACHE || chunkNbtCacheBytes > MAX_CHUNK_NBT_CACHE_BYTES) {
    const oldestKey = chunkNbtCache.keys().next().value;
    if (!oldestKey) break;
    deleteChunkNbtCache(oldestKey);
  }
  return value;
}

function deleteChunkNbtCache(key: string) {
  const hit = chunkNbtCache.get(key);
  if (!hit) return;
  chunkNbtCacheBytes -= hit.data.byteLength;
  chunkNbtCache.delete(key);
}

function invalidatePath(filePath: string) {
  const clean = cleanStoragePath(filePath);
  fileHashCache.delete(clean);
  deleteRegionCache(clean);
  regionHeaderCache.delete(clean);
  regionReadInflight.delete(clean);
  regionHeaderInflight.delete(clean);
  for (const [key, entry] of chunkNbtCache) {
    if (entry.sourcePath === clean) deleteChunkNbtCache(key);
  }
}

function clearChunkCacheFor(world: string, dim?: string) {
  const prefix = dim ? `${world}|${dim}|` : `${world}|`;
  for (const key of [...chunkNbtCache.keys()]) {
    if (key.startsWith(prefix)) deleteChunkNbtCache(key);
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
  rememberLru(fileHashCache, clean, { validator: v, hash }, MAX_FILE_HASH_CACHE);
  return hash;
}

function dimensionRegionCandidates(dim: string): string[] {
  if (VANILLA_DIMS[dim]) return VANILLA_DIMS[dim];
  const [namespace, rawPath = ''] = dim.includes(':') ? dim.split(':') : ['minecraft', dim];
  const dimPath = rawPath.split('/').map(encodeURIComponent).join('/');
  return [`dimensions/${encodeURIComponent(namespace)}/${dimPath}/region`];
}

function dimensionEntityCandidates(dim: string): string[] {
  return dimensionRegionCandidates(dim).map((candidate) => candidate.replace(/\/region$/, '/entities'));
}

async function prefixHasRegionFiles(prefix: string): Promise<boolean> {
  const files = await worldStorage.list(prefix);
  return files.some((f) => REGION_RE.test(f.path.split('/').pop() ?? ''));
}

async function regionDir(world: string, dim: string): Promise<string> {
  assertWorldName(world);
  const key = `${world}|${dim}`;
  const cached = regionDirCache.get(key);
  if (cached) return cached;
  const candidates = dimensionRegionCandidates(dim).map((sub) => `${world}/${sub}`);
  for (const candidate of candidates) {
    if (await prefixHasRegionFiles(candidate)) {
      regionDirCache.set(key, candidate);
      return candidate;
    }
  }
  regionDirCache.set(key, candidates[0]);
  return candidates[0];
}

async function entityDir(world: string, dim: string): Promise<string> {
  assertWorldName(world);
  const key = `${world}|${dim}`;
  const cached = entityDirCache.get(key);
  if (cached) return cached;
  const candidates = dimensionEntityCandidates(dim).map((sub) => `${world}/${sub}`);
  for (const candidate of candidates) {
    if (await prefixHasRegionFiles(candidate)) {
      entityDirCache.set(key, candidate);
      return candidate;
    }
  }
  entityDirCache.set(key, candidates[0]);
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
  return hasRegionChunkHeader(region, localX, localZ);
}

function hasRegionChunkHeader(header: Uint8Array, localX: number, localZ: number): boolean {
  if (header.length < REGION_LOCATION_BYTES) return false;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
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
  const pending = regionReadInflight.get(clean);
  if (pending) return pending;
  const load = (async () => {
    const bytes = await worldStorage.read(clean);
    if (!bytes) return null;
    const hash = sourceHashForInfo(info);
    if (bytes.length >= REGION_LOCATION_BYTES) {
      rememberLru(regionHeaderCache, clean, {
        validator: v,
        hash,
        header: bytes.subarray(0, REGION_LOCATION_BYTES).slice(),
      }, MAX_REGION_HEADER_CACHE);
    }
    return rememberRegionCache(clean, { validator: v, hash, bytes });
  })();
  regionReadInflight.set(clean, load);
  try {
    return await load;
  } finally {
    regionReadInflight.delete(clean);
  }
}

async function readRegionHeader(filePath: string): Promise<RegionHeaderCacheEntry | null> {
  const info = await worldStorage.stat(filePath);
  if (!info) return null;
  const clean = cleanStoragePath(filePath);
  const v = validator(info);
  const fullHit = regionCache.get(clean);
  if (fullHit?.validator === v) {
    return { validator: v, hash: fullHit.hash, header: fullHit.bytes.subarray(0, REGION_LOCATION_BYTES) };
  }
  const hit = regionHeaderCache.get(clean);
  if (hit?.validator === v) {
    regionHeaderCache.delete(clean);
    regionHeaderCache.set(clean, hit);
    return hit;
  }
  const pending = regionHeaderInflight.get(clean);
  if (pending) return pending;
  const load = (async () => {
    const header = await worldStorage.readRange(clean, 0, REGION_LOCATION_BYTES);
    if (!header || header.length < REGION_LOCATION_BYTES) return null;
    const value: RegionHeaderCacheEntry = { validator: v, hash: sourceHashForInfo(info), header };
    return rememberLru(regionHeaderCache, clean, value, MAX_REGION_HEADER_CACHE);
  })();
  regionHeaderInflight.set(clean, load);
  try {
    return await load;
  } finally {
    regionHeaderInflight.delete(clean);
  }
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
  await ensureWorldIdentity(new PrefixedWorldStorage(worldStorage, world));
  invalidateWorldList();
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

async function listWorldsUncached(): Promise<WorldInfo[]> {
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

export async function listWorlds(): Promise<WorldInfo[]> {
  const now = Date.now();
  if (worldListCache && worldListCache.expiresAt > now) return worldListCache.worlds;
  if (worldListInflight) return worldListInflight;
  const pending = listWorldsUncached();
  worldListInflight = pending;
  try {
    const worlds = await pending;
    worldListCache = { worlds, expiresAt: Date.now() + WORLD_LIST_CACHE_MS };
    return worlds;
  } finally {
    if (worldListInflight === pending) worldListInflight = null;
  }
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

export async function listChunkSourceCoverage(world: string, dim: string): Promise<ChunkSourceCoverage> {
  const [regions, chunks] = await Promise.all([
    listRegionChunkMasks(world, dim),
    listChunkOverrides(world, dim),
  ]);
  return { regions, chunks };
}

async function listRegionChunkMasks(world: string, dim: string): Promise<{ x: number; z: number; mask: string }[]> {
  const out = new Map<string, { x: number; z: number; mask: string }>();
  for (const sub of dimensionRegionCandidates(dim)) {
    const prefix = `${world}/${sub}`;
    for (const file of await worldStorage.list(prefix)) {
      const match = REGION_RE.exec(file.path.split('/').pop() ?? '');
      if (!match) continue;
      const x = Number(match[1]);
      const z = Number(match[2]);
      const header = await readRegionHeader(file.path);
      out.set(`${x},${z}`, { x, z, mask: regionChunkMask(header?.header) });
    }
  }
  return [...out.values()].sort((a, b) => a.x - b.x || a.z - b.z);
}

function regionChunkMask(header: Uint8Array | undefined): string {
  const mask = new Uint8Array(128);
  if (header) {
    for (let z = 0; z < 32; z++) {
      for (let x = 0; x < 32; x++) {
        if (!hasRegionChunkHeader(header, x, z)) continue;
        const index = x + z * 32;
        mask[index >> 3] |= 1 << (index & 7);
      }
    }
  }
  return Buffer.from(mask).toString('base64');
}

async function listChunkOverrides(world: string, dim: string): Promise<{ cx: number; cz: number }[]> {
  const out = new Map<string, { cx: number; cz: number }>();
  for (const file of await worldStorage.list(chunkOverrideDir(world, dim))) {
    const match = CHUNK_RE.exec(file.path.split('/').pop() ?? '');
    if (!match) continue;
    const item = { cx: Number(match[1]), cz: Number(match[2]) };
    out.set(`${item.cx},${item.cz}`, item);
  }
  return [...out.values()].sort((a, b) => a.cx - b.cx || a.cz - b.cz);
}

export async function getChunkMetadataBatch(
  world: string,
  dim: string,
  chunks: { cx: number; cz: number }[],
): Promise<ChunkMetadata[]> {
  assertWorldName(world);
  const [regionBase, entityBase] = await Promise.all([regionDir(world, dim), entityDir(world, dim)]);
  const out = new Array<ChunkMetadata>(chunks.length);
  const byRegion = new Map<string, { rx: number; rz: number; filePath: string; items: { index: number; cx: number; cz: number }[] }>();

  await Promise.all(chunks.map(async ({ cx, cz }, index) => {
    if (!Number.isInteger(cx) || !Number.isInteger(cz)) {
      out[index] = { cx, cz, missing: true };
      return;
    }

    const chunkPath = `${chunkOverrideDir(world, dim)}/c.${cx}.${cz}.nbt`;
    const chunkInfo = await worldStorage.stat(chunkPath);
    if (chunkInfo) {
      const fileHash = sourceHashForInfo(chunkInfo);
      out[index] = { cx, cz, hash: fileHash, fileHash, source: 'chunk', sourcePath: chunkPath };
      return;
    }

    const rx = cx >> 5;
    const rz = cz >> 5;
    const key = `${rx},${rz}`;
    const filePath = regionPathFromDir(regionBase, rx, rz);
    const group = byRegion.get(key) ?? { rx, rz, filePath, items: [] };
    group.items.push({ index, cx, cz });
    byRegion.set(key, group);
  }));

  await Promise.all([...byRegion.values()].map(async (group) => {
    const region = await readRegionHeader(group.filePath);
    for (const item of group.items) {
      if (!region || !hasRegionChunkHeader(region.header, item.cx & 31, item.cz & 31)) {
        out[item.index] = { cx: item.cx, cz: item.cz, missing: true };
        continue;
      }
      out[item.index] = {
        cx: item.cx,
        cz: item.cz,
        hash: region.hash,
        fileHash: region.hash,
        source: 'region',
        sourcePath: group.filePath,
        region: { x: group.rx, z: group.rz },
      };
    }
  }));

  // Since 1.17 entities live in a sibling region directory. Attach its
  // validator to the terrain metadata so a changed entity chunk invalidates
  // the browser mesh cache even when block data stayed identical.
  const entityRegions = new Map<string, { filePath: string; items: { index: number; cx: number; cz: number }[] }>();
  for (let index = 0; index < out.length; index++) {
    const meta = out[index];
    if (!meta || meta.missing || !meta.hash) continue;
    const rx = meta.cx >> 5;
    const rz = meta.cz >> 5;
    const filePath = regionPathFromDir(entityBase, rx, rz);
    const group = entityRegions.get(filePath) ?? { filePath, items: [] };
    group.items.push({ index, cx: meta.cx, cz: meta.cz });
    entityRegions.set(filePath, group);
  }
  await Promise.all([...entityRegions.values()].map(async (group) => {
    const region = await readRegionHeader(group.filePath);
    if (!region) return;
    for (const item of group.items) {
      const meta = out[item.index];
      if (!meta || !hasRegionChunkHeader(region.header, item.cx & 31, item.cz & 31)) continue;
      meta.entityHash = region.hash;
      meta.entitySourcePath = group.filePath;
      // `hash` is a source validator used before full NBT is fetched. Include
      // entities here; `nbtHash` below remains the precise payload hash.
      meta.hash = `v3:${sha256(new TextEncoder().encode(`${meta.hash}|${region.hash}`))}`;
    }
  }));

  return out;
}

export async function getChunkMetadata(world: string, dim: string, cx: number, cz: number): Promise<ChunkMetadata> {
  return (await getChunkMetadataBatch(world, dim, [{ cx, cz }]))[0] ?? { cx, cz, missing: true };
}

export async function getChunksNbtWithMetaBatch(
  world: string,
  dim: string,
  chunks: { cx: number; cz: number }[],
): Promise<(ChunkReadResult | null)[]> {
  const metas = await getChunkMetadataBatch(world, dim, chunks);
  const out = new Array<ChunkReadResult | null>(metas.length).fill(null);
  const byRegion = new Map<string, { meta: ChunkMetadata; index: number }[]>();

  await Promise.all(metas.map(async (meta, index) => {
    if (!meta.hash || !meta.fileHash || !meta.source || !meta.sourcePath || meta.missing) return;

    const cacheKey = chunkCacheKey(world, dim, meta.cx, meta.cz);
    const hit = chunkNbtCache.get(cacheKey);
    if (hit?.sourcePath === meta.sourcePath && hit.fileHash === meta.fileHash && hit.entityHash === meta.entityHash) {
      touchLru(chunkNbtCache, cacheKey, hit);
      out[index] = { ...meta, data: hit.data, entities: hit.entities, nbtHash: hit.nbtHash } as ChunkReadResult;
      return;
    }

    if (meta.source === 'chunk') {
      const bytes = await worldStorage.read(meta.sourcePath);
      const data = bytes ? decompress(bytes) : null;
      if (!data) return;
      out[index] = { ...meta, data, nbtHash: chunkPayloadHash(data) } as ChunkReadResult;
      return;
    }

    const group = byRegion.get(meta.sourcePath) ?? [];
    group.push({ meta, index });
    byRegion.set(meta.sourcePath, group);
  }));

  await Promise.all([...byRegion.entries()].map(async ([filePath, items]) => {
    const region = await readRegionFile(filePath);
    if (!region) return;
    for (const { meta, index } of items) {
      if (!meta.fileHash || !meta.sourcePath) continue;
      const data = getRegionChunk(region.bytes, meta.cx & 31, meta.cz & 31);
      if (!data) continue;
      out[index] = { ...meta, data, nbtHash: chunkPayloadHash(data) } as ChunkReadResult;
    }
  }));

  const byEntityRegion = new Map<string, { meta: ChunkMetadata; index: number }[]>();
  for (let index = 0; index < metas.length; index++) {
    const meta = metas[index];
    if (!out[index]?.data || !meta?.entitySourcePath) continue;
    const group = byEntityRegion.get(meta.entitySourcePath) ?? [];
    group.push({ meta, index });
    byEntityRegion.set(meta.entitySourcePath, group);
  }
  await Promise.all([...byEntityRegion.entries()].map(async ([filePath, items]) => {
    const region = await readRegionFile(filePath);
    if (!region) return;
    for (const { meta, index } of items) {
      const result = out[index];
      if (!result) continue;
      const entities = getRegionChunk(region.bytes, meta.cx & 31, meta.cz & 31) ?? undefined;
      result.entities = entities;
      result.nbtHash = chunkPayloadHash(result.data, entities);
    }
  }));

  // Cache only after both terrain and optional entity NBT have been merged.
  for (const result of out) {
    if (!result?.data || !result.sourcePath || !result.fileHash) continue;
    rememberChunkNbtCache(chunkCacheKey(world, dim, result.cx, result.cz), {
      sourcePath: result.sourcePath,
      fileHash: result.fileHash,
      data: result.data,
      nbtHash: result.nbtHash ?? chunkPayloadHash(result.data, result.entities),
      entityHash: result.entityHash,
      entities: result.entities,
    });
  }

  return out;
}

export async function getChunkNbtWithMeta(world: string, dim: string, cx: number, cz: number): Promise<ChunkReadResult | null> {
  return (await getChunksNbtWithMetaBatch(world, dim, [{ cx, cz }]))[0] ?? null;
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
  const info = await worldStorage.stat(filePath);
  const fileHash = info ? sourceHashForInfo(info) : sha256(data);
  rememberChunkNbtCache(chunkCacheKey(world, dim, x, z), {
    sourcePath: filePath,
    fileHash,
    data,
    nbtHash: sha256(data),
  });
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
  invalidateWorldList();
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
