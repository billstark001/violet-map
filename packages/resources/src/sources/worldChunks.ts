import { mapWithConcurrency } from '@violet-map/core/async';
import { LruCache } from '@violet-map/core/cache';
import type { ChunkCoverage, WorldInfo } from '@violet-map/core/contracts';
import {
  assertDimensionId,
  assertWorldName,
  dimensionRegionPaths,
  isChunkCoordinate,
  isDimensionId,
  isWorldName,
  VANILLA_DIMENSION_IDS,
} from '@violet-map/core/domain';
import { parseRegionFileName, regionChunkRange, parseRegionChunkRecord } from '@violet-map/core/region';
import { canonicalJson, ResourceError } from '@violet-map/core/resources';
import type { ObjectReader, StoredFileInfo } from '@violet-map/core/storage';
import { cleanStoragePath, sha256 } from '@violet-map/storage';
import type { ObjectScanner } from '@violet-map/storage';
import { chunkIdentity } from '../chunkIdentity.js';
import { decodeRegionChunk, decompressNbt } from './nbtCodec.js';

export interface ChunkMetadata {
  cx: number;
  cz: number;
  missing?: boolean;
  sourceRevision?: string;
  terrainRevision?: string;
  entityRevision?: string;
  source?: 'region' | 'chunk';
  region?: { x: number; z: number };
  sourcePath?: string;
  entitySourcePath?: string;
}

export interface ChunkReadResult extends ChunkMetadata {
  data: Uint8Array;
  entities?: Uint8Array;
  sourceRevision: string;
  terrainRevision: string;
  contentDigest: string;
  terrainDigest: string;
  entityDigest?: string;
  source: 'region' | 'chunk';
  sourcePath: string;
}

export interface WorldSourceOptions {
  entities?: boolean;
  cache: { regionBytes: number; chunkNbtBytes: number; worldListMs: number; metadataEntries?: number };
}

export interface RegionCacheEntry {
  validator: string;
  bytes: Uint8Array;
}

export function createWorldSource(worldStorage: ObjectReader, config: WorldSourceOptions) {
  async function readSource(key: string): Promise<Uint8Array | null> {
    const info = await worldStorage.stat(key);
    if (!info) return null;
    const maximum = key.endsWith('.mca') ? 32 * 1024 ** 2 : 16 * 1024 ** 2;
    if (info.size > maximum) throw new ResourceError('RESOURCE_BUSY', 'source object exceeds generation input budget');
    const bytes = await worldStorage.readRange(key, 0, info.size + 1);
    if (!bytes || bytes.byteLength !== info.size)
      throw new ResourceError('SOURCE_SNAPSHOT_CHANGED', 'source object changed during read', true);
    return bytes;
  }
  const DEFAULT_DIMS = ['minecraft:overworld'];
  const CHUNK_RE = /^c\.(-?\d+)\.(-?\d+)\.nbt$/;
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

  interface RegionHeaderCacheEntry {
    validator: string;
    header: Uint8Array;
  }
  interface ChunkCacheEntry {
    sourcePath: string;
    terrainRevision: string;
    data: Uint8Array;
    contentDigest: string;
    terrainDigest: string;
    entityDigest?: string;
    entityRevision?: string;
    entities?: Uint8Array;
  }
  const fileDigestCache = new LruCache<string, HashCacheEntry>({ maxEntries: config.cache.metadataEntries ?? 4096 });
  const regionCache = new LruCache<string, RegionCacheEntry>({
    maxEntries: 16,
    maxWeight: config.cache.regionBytes,
    weightOf: (entry) => entry.bytes.byteLength,
  });
  const regionHeaderCache = new LruCache<string, RegionHeaderCacheEntry>({
    maxEntries: config.cache.metadataEntries ?? 256,
  });
  const regionReadInflight = new Map<string, Promise<RegionCacheEntry | null>>();
  const regionHeaderInflight = new Map<string, Promise<RegionHeaderCacheEntry | null>>();
  const regionDirCache = new LruCache<string, string>({ maxEntries: config.cache.metadataEntries ?? 1024 });
  const entityDirCache = new LruCache<string, string>({ maxEntries: config.cache.metadataEntries ?? 1024 });
  const chunkNbtCache = new LruCache<string, ChunkCacheEntry>({
    maxEntries: 512,
    maxWeight: config.cache.chunkNbtBytes,
    weightOf: (entry) => entry.data.byteLength + (entry.entities?.byteLength ?? 0),
  });
  const REGION_LOCATION_BYTES = 4096;
  const MAX_PARALLEL_STORAGE_READS = 16;

  let storageCacheGeneration = 0;
  const WORLD_LIST_CACHE_MS = config.cache.worldListMs;
  let worldListCache: { expiresAt: number; worlds: WorldInfo[] } | null = null;
  let worldListInflight: Promise<WorldInfo[]> | null = null;
  function invalidateWorldList(): void {
    worldListCache = null;
    worldListInflight = null;
  }
  const dimDirName = (dim: string) => encodeURIComponent(dim);
  const chunkCacheKey = (world: string, dim: string, cx: number, cz: number) => `${world}|${dim}|${cx},${cz}`;
  const levelDatPath = (world: string) => `${world}/level.dat`;
  const worldMetaPath = (world: string) => `${world}/.violet-map/world.json`;
  function validator(info: StoredFileInfo): string {
    return `${info.size}:${info.modifiedAt ?? ''}:${info.etag ?? ''}`;
  }
  function invalidatePath(filePath: string) {
    storageCacheGeneration++;
    const clean = cleanStoragePath(filePath);
    fileDigestCache.delete(clean);
    regionCache.delete(clean);
    regionHeaderCache.delete(clean);
    regionReadInflight.delete(clean);
    regionHeaderInflight.delete(clean);
    for (const [key, entry] of chunkNbtCache) {
      if (entry.sourcePath === clean) chunkNbtCache.delete(key);
    }
  }
  function clearChunkCacheFor(world: string, dim?: string) {
    storageCacheGeneration++;
    const prefix = dim ? `${world}|${dim}|` : `${world}|`;
    for (const key of [...chunkNbtCache.keys()]) {
      if (key.startsWith(prefix)) chunkNbtCache.delete(key);
    }
  }
  function clearWorldDirectoryCaches(world: string): void {
    for (const key of regionDirCache.keys()) if (key.startsWith(`${world}|`)) regionDirCache.delete(key);
    for (const key of entityDirCache.keys()) if (key.startsWith(`${world}|`)) entityDirCache.delete(key);
  }
  function clearWorldObjectCaches(world: string): void {
    const prefix = `${world}/`;
    for (const cache of [fileDigestCache, regionCache, regionHeaderCache, regionReadInflight, regionHeaderInflight]) {
      for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
    }
  }
  function invalidateStoredFile(filePath: string): void {
    const clean = cleanStoragePath(filePath);
    invalidatePath(clean);
    const separator = clean.indexOf('/');
    if (separator < 1) return;
    const world = clean.slice(0, separator);
    if (!isWorldName(world)) return;
    const relative = clean.slice(separator + 1);
    invalidateWorldList();

    if (
      relative.includes('/region/') ||
      relative.startsWith('region/') ||
      relative.includes('/entities/') ||
      relative.startsWith('entities/') ||
      relative.startsWith('chunks/')
    ) {
      clearWorldDirectoryCaches(world);
      clearChunkCacheFor(world);
    }
  }
  async function hashFileInfo(info: StoredFileInfo): Promise<string> {
    const clean = cleanStoragePath(info.path);
    const v = validator(info);
    const hit = fileDigestCache.get(clean);
    if (hit?.validator === v) return hit.hash;
    const generation = storageCacheGeneration;
    const bytes = await readSource(clean);
    if (!bytes) throw new Error(`file disappeared while hashing: ${clean}`);
    const hash = sha256(bytes);
    if (generation === storageCacheGeneration) fileDigestCache.set(clean, { validator: v, hash });
    return hash;
  }
  function dimensionEntityCandidates(dim: string): string[] {
    return dimensionRegionPaths(dim).map((candidate) => candidate.replace(/(^|\/)region$/, '$1entities'));
  }
  async function prefixHasRegionFiles(prefix: string): Promise<boolean> {
    // Layout discovery needs one matching basename, not metadata for every
    // region in the dimension. Select streaming before I/O when supported.
    const scan = (worldStorage as ObjectReader & Partial<ObjectScanner>).scan;
    const files = scan ? scan.call(worldStorage, prefix) : await worldStorage.list(prefix);
    for await (const file of files) if (parseRegionFileName(file.path.split('/').pop() ?? '') !== null) return true;
    return false;
  }
  async function regionDir(world: string, dim: string): Promise<string> {
    assertWorldName(world);
    const key = `${world}|${dim}`;
    const cached = regionDirCache.get(key);
    if (cached) return cached;
    const generation = storageCacheGeneration;
    const candidates = dimensionRegionPaths(dim).map((sub) => `${world}/${sub}`);
    for (const candidate of candidates) {
      if (await prefixHasRegionFiles(candidate)) {
        if (generation === storageCacheGeneration) regionDirCache.set(key, candidate);
        return candidate;
      }
    }
    // An empty world may receive its first region through remote storage sync.
    // Do not pin the fallback before a file establishes the actual layout.
    return candidates[0];
  }
  async function entityDir(world: string, dim: string): Promise<string> {
    assertWorldName(world);
    const key = `${world}|${dim}`;
    const cached = entityDirCache.get(key);
    if (cached) return cached;
    const generation = storageCacheGeneration;
    const candidates = dimensionEntityCandidates(dim).map((sub) => `${world}/${sub}`);
    for (const candidate of candidates) {
      if (await prefixHasRegionFiles(candidate)) {
        if (generation === storageCacheGeneration) entityDirCache.set(key, candidate);
        return candidate;
      }
    }
    return candidates[0];
  }
  function chunkOverrideDir(world: string, dim: string): string {
    assertWorldName(world);
    assertDimensionId(dim);
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
    return loc >>> 8 !== 0 && (loc & 0xff) !== 0;
  }
  async function regionFileInfo(filePath: string): Promise<StoredFileInfo | null> {
    const info = await worldStorage.stat(filePath);
    // Archives may retain zero-byte region placeholders without saved chunks.
    // Nonempty regions still require both complete header sectors.
    if (!info || info.size === 0) return null;
    if (info.size < 8192) throw new ResourceError('RESOURCE_INTEGRITY_FAILED', 'source region header is truncated');
    return info;
  }
  async function readRegionFile(filePath: string): Promise<RegionCacheEntry | null> {
    const info = await regionFileInfo(filePath);
    if (!info) return null;
    const clean = cleanStoragePath(filePath);
    const v = validator(info);
    const hit = regionCache.get(clean);
    if (hit?.validator === v) return hit;
    const pending = regionReadInflight.get(clean);
    if (pending) return pending;
    let load!: Promise<RegionCacheEntry | null>;
    load = (async () => {
      const bytes = await readSource(clean);
      if (!bytes) throw new ResourceError('SOURCE_SNAPSHOT_CHANGED', 'region disappeared during read', true);
      if (bytes.byteLength !== info.size)
        throw new ResourceError('SOURCE_SNAPSHOT_CHANGED', 'region size changed during read', true);
      if (regionReadInflight.get(clean) === load && bytes.length >= REGION_LOCATION_BYTES) {
        regionHeaderCache.set(clean, {
          validator: v,
          header: bytes.subarray(0, REGION_LOCATION_BYTES).slice(),
        });
      }
      const value = { validator: v, bytes };
      if (regionReadInflight.get(clean) === load) regionCache.set(clean, value);
      return value;
    })();
    regionReadInflight.set(clean, load);
    try {
      return await load;
    } finally {
      if (regionReadInflight.get(clean) === load) regionReadInflight.delete(clean);
    }
  }
  async function readRegionHeader(filePath: string): Promise<RegionHeaderCacheEntry | null> {
    const info = await regionFileInfo(filePath);
    if (!info) return null;
    const clean = cleanStoragePath(filePath);
    const v = validator(info);
    const fullHit = regionCache.get(clean);
    if (fullHit?.validator === v) {
      return { validator: v, header: fullHit.bytes.subarray(0, REGION_LOCATION_BYTES) };
    }
    const hit = regionHeaderCache.get(clean);
    if (hit?.validator === v) return hit;
    const pending = regionHeaderInflight.get(clean);
    if (pending) return pending;
    let load!: Promise<RegionHeaderCacheEntry | null>;
    load = (async () => {
      const header = await worldStorage.readRange(clean, 0, REGION_LOCATION_BYTES);
      if (!header || header.length < REGION_LOCATION_BYTES)
        throw new ResourceError('SOURCE_SNAPSHOT_CHANGED', 'region header changed during read', true);
      const value: RegionHeaderCacheEntry = { validator: v, header };
      if (regionHeaderInflight.get(clean) === load) regionHeaderCache.set(clean, value);
      return value;
    })();
    regionHeaderInflight.set(clean, load);
    try {
      return await load;
    } finally {
      if (regionHeaderInflight.get(clean) === load) regionHeaderInflight.delete(clean);
    }
  }
  async function readJson<T>(filePath: string): Promise<T | null> {
    const bytes = await readSource(filePath);
    if (!bytes) return null;
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as T;
    } catch {
      return null;
    }
  }

  async function readRegionChunks(filePath: string, items: { meta: ChunkMetadata; index: number }[], entity = false) {
    const header = await readRegionHeader(filePath);
    if (!header) throw new ResourceError('SOURCE_SNAPSHOT_CHANGED', 'region disappeared during read', true);
    const expected = entity ? items[0]?.meta.entityRevision : items[0]?.meta.terrainRevision;
    if (header.validator !== expected)
      throw new ResourceError('SOURCE_SNAPSHOT_CHANGED', 'region changed before reading its records', true);
    const retained = regionCache.get(cleanStoragePath(filePath));
    const bytes = retained?.validator === expected ? retained.bytes : undefined;
    // A batch shares its header and revision checks. Decode spans in order to
    // bound compressed/decompressed input independently of the batch length.
    const results: Uint8Array[] = [];
    for (const { meta } of items) {
      const range = regionChunkRange(header.header, meta.cx & 31, meta.cz & 31);
      if (!range) throw new ResourceError('RESOURCE_INTEGRITY_FAILED', 'declared chunk has an invalid location');
      const span =
        bytes?.subarray(range.start, range.start + range.length) ??
        (await worldStorage.readRange(filePath, range.start, range.length));
      let record;
      try {
        record = span && parseRegionChunkRecord(span, range.length);
      } catch {
        throw new ResourceError('RESOURCE_INTEGRITY_FAILED', 'declared chunk has unsupported compression');
      }
      if (!record) throw new ResourceError('RESOURCE_INTEGRITY_FAILED', 'declared chunk record is truncated');
      results.push(await decodeRegionChunk(record));
    }
    const after = await regionFileInfo(filePath);
    if (!after || validator(after) !== expected)
      throw new ResourceError('SOURCE_SNAPSHOT_CHANGED', 'region changed while reading its records', true);
    return results;
  }
  function addEncodedDimension(encoded: string, dimensions: Set<string>): void {
    try {
      const dimension = decodeURIComponent(encoded);
      if (isDimensionId(dimension)) dimensions.add(dimension);
    } catch {
      // A malformed directory name must not hide otherwise valid worlds.
    }
  }
  function addDimensionFromPath(rest: string[], dims: Set<string>) {
    if (rest[0] === 'region' && parseRegionFileName(rest.at(-1) ?? '') !== null) dims.add('minecraft:overworld');
    else if (rest[0] === 'DIM-1' && rest[1] === 'region' && parseRegionFileName(rest.at(-1) ?? '') !== null)
      dims.add('minecraft:the_nether');
    else if (rest[0] === 'DIM1' && rest[1] === 'region' && parseRegionFileName(rest.at(-1) ?? '') !== null)
      dims.add('minecraft:the_end');
    else if (rest[0] === 'chunks' && rest[1]) addEncodedDimension(rest[1], dims);
    else if (rest[0] === 'dimensions' && rest.length >= 5) {
      const regionIndex = rest.length - 2;
      if (rest[regionIndex] === 'region' && parseRegionFileName(rest.at(-1) ?? '') !== null) {
        addEncodedDimension(`${rest[1]}:${rest.slice(2, regionIndex).join('/')}`, dims);
      }
    }
  }
  async function listWorldsUncached(): Promise<WorldInfo[]> {
    const byWorld = new Map<string, Set<string>>();
    for (const world of await worldStorage.listDirectories()) {
      if (!isWorldName(world)) continue;
      const dims = new Set<string>();
      const meta = await readJson<WorldMeta>(worldMetaPath(world));
      for (const dim of Array.isArray(meta?.dimensions) ? meta.dimensions : []) if (isDimensionId(dim)) dims.add(dim);
      if (await worldStorage.stat(levelDatPath(world))) {
        for (const dim of Array.isArray(meta?.dimensions) ? meta.dimensions : DEFAULT_DIMS)
          if (isDimensionId(dim)) dims.add(dim);
      }
      for (const dim of VANILLA_DIMENSION_IDS) {
        if (await prefixHasRegionFiles(`${world}/${dimensionRegionPaths(dim)[0]}`)) dims.add(dim);
        else {
          const [, modern] = dimensionRegionPaths(dim);
          if (modern && (await prefixHasRegionFiles(`${world}/${modern}`))) dims.add(dim);
        }
      }
      for (const chunkDim of await worldStorage.listDirectories(`${world}/chunks`)) {
        addEncodedDimension(chunkDim, dims);
      }
      for (const file of await worldStorage.list(`${world}/dimensions`)) {
        addDimensionFromPath(file.path.split('/').slice(1), dims);
      }
      if (dims.size) byWorld.set(world, dims);
    }
    return [...byWorld.entries()]
      .map(([id, dimensions]) => ({ id, dimensions: [...dimensions].sort() }))
      .filter((w) => w.dimensions.length > 0)
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  async function listWorlds(): Promise<WorldInfo[]> {
    const now = Date.now();
    if (worldListCache && worldListCache.expiresAt > now) return worldListCache.worlds;
    if (worldListInflight) return worldListInflight;
    const pending = listWorldsUncached();
    worldListInflight = pending;
    try {
      const worlds = await pending;
      if (worldListInflight === pending) worldListCache = { worlds, expiresAt: Date.now() + WORLD_LIST_CACHE_MS };
      return worlds;
    } finally {
      if (worldListInflight === pending) worldListInflight = null;
    }
  }
  async function listRegions(world: string, dim: string): Promise<{ x: number; z: number }[]> {
    const out = new Map<string, { x: number; z: number }>();
    for (const sub of dimensionRegionPaths(dim)) {
      for (const file of await worldStorage.list(`${world}/${sub}`)) {
        const item = parseRegionFileName(file.path.split('/').pop() ?? '');
        if (!item || file.size === 0) continue;
        out.set(`${item.x},${item.z}`, item);
      }
    }
    return [...out.values()].sort((a, b) => a.x - b.x || a.z - b.z);
  }
  async function listChunkSourceCoverage(world: string, dim: string): Promise<ChunkCoverage> {
    const [regions, chunks] = await Promise.all([listRegionChunkMasks(world, dim), listChunkOverrides(world, dim)]);
    return { regions, chunks };
  }
  async function listRegionChunkMasks(world: string, dim: string): Promise<{ x: number; z: number; mask: string }[]> {
    const out = new Map<string, { x: number; z: number; mask: string }>();
    const regionFiles: { path: string; x: number; z: number }[] = [];
    for (const sub of dimensionRegionPaths(dim)) {
      const prefix = `${world}/${sub}`;
      for (const file of await worldStorage.list(prefix)) {
        const item = parseRegionFileName(file.path.split('/').pop() ?? '');
        if (!item || file.size === 0) continue;
        regionFiles.push({ path: file.path, ...item });
      }
    }
    const masks = await mapWithConcurrency(regionFiles, MAX_PARALLEL_STORAGE_READS, async (file) => {
      const header = await readRegionHeader(file.path);
      return { x: file.x, z: file.z, mask: regionChunkMask(header?.header) };
    });
    for (const item of masks) out.set(`${item.x},${item.z}`, item);
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
      if (!isChunkCoordinate(item.cx) || !isChunkCoordinate(item.cz)) continue;
      out.set(`${item.cx},${item.cz}`, item);
    }
    return [...out.values()].sort((a, b) => a.cx - b.cx || a.cz - b.cz);
  }
  const inspections = new Map<string, Promise<{ regionBase: string; entityBase: string; hasOverrides: boolean }>>();
  async function inspectLayout(world: string, dim: string) {
    const key = JSON.stringify([storageCacheGeneration, world, dim]);
    const known = inspections.get(key);
    if (known) return known;
    if (inspections.size >= MAX_PARALLEL_STORAGE_READS)
      throw new ResourceError('RESOURCE_BUSY', 'source inspection limit exhausted', true);
    const owned = Promise.all([
      regionDir(world, dim),
      entityDir(world, dim),
      worldStorage.listDirectories(`${world}/chunks`),
    ]).then(([regionBase, entityBase, directories]) => ({
      regionBase,
      entityBase,
      hasOverrides: directories.includes(dimDirName(dim)),
    }));
    inspections.set(key, owned);
    try {
      return await owned;
    } finally {
      if (inspections.get(key) === owned) inspections.delete(key);
    }
  }
  async function inspectChunks(
    world: string,
    dim: string,
    chunks: { cx: number; cz: number }[],
  ): Promise<ChunkMetadata[]> {
    assertWorldName(world);
    const overrideDirectory = chunkOverrideDir(world, dim);
    const { regionBase, entityBase, hasOverrides } = await inspectLayout(world, dim);
    // Most archives contain only MCA regions. One delimiter listing avoids a
    // missing-object HEAD for every requested chunk; writes invalidate the
    // storage directory cache, and external changes follow its configured TTL.
    const out = new Array<ChunkMetadata>(chunks.length);
    const byRegion = new Map<
      string,
      { rx: number; rz: number; filePath: string; items: { index: number; cx: number; cz: number }[] }
    >();

    await mapWithConcurrency(chunks, MAX_PARALLEL_STORAGE_READS, async ({ cx, cz }, index) => {
      if (!isChunkCoordinate(cx) || !isChunkCoordinate(cz)) {
        out[index] = { cx, cz, missing: true };
        return;
      }

      const chunkPath = `${overrideDirectory}/c.${cx}.${cz}.nbt`;
      const chunkInfo = hasOverrides ? await worldStorage.stat(chunkPath) : null;
      if (chunkInfo) {
        const terrainRevision = validator(chunkInfo);
        out[index] = {
          cx,
          cz,
          sourceRevision: terrainRevision,
          terrainRevision,
          source: 'chunk',
          sourcePath: chunkPath,
        };
        return;
      }

      const rx = cx >> 5;
      const rz = cz >> 5;
      const key = `${rx},${rz}`;
      const filePath = regionPathFromDir(regionBase, rx, rz);
      const group = byRegion.get(key) ?? { rx, rz, filePath, items: [] };
      group.items.push({ index, cx, cz });
      byRegion.set(key, group);
    });

    await mapWithConcurrency([...byRegion.values()], MAX_PARALLEL_STORAGE_READS, async (group) => {
      const region = await readRegionHeader(group.filePath);
      for (const item of group.items) {
        if (!region || !hasRegionChunkHeader(region.header, item.cx & 31, item.cz & 31)) {
          out[item.index] = { cx: item.cx, cz: item.cz, missing: true };
          continue;
        }
        out[item.index] = {
          cx: item.cx,
          cz: item.cz,
          sourceRevision: region.validator,
          terrainRevision: region.validator,
          source: 'region',
          sourcePath: group.filePath,
          region: { x: group.rx, z: group.rz },
        };
      }
    });

    // Since 1.17 entities live in a sibling region directory. Attach its
    // validator to the terrain metadata so a changed entity chunk invalidates
    // the browser mesh cache even when block data stayed identical.
    if (config.entities === false) return out;
    const entityRegions = new Map<string, { filePath: string; items: { index: number; cx: number; cz: number }[] }>();
    for (let index = 0; index < out.length; index++) {
      const meta = out[index];
      if (!meta || meta.missing || !meta.sourceRevision) continue;
      const rx = meta.cx >> 5;
      const rz = meta.cz >> 5;
      const filePath = regionPathFromDir(entityBase, rx, rz);
      const group = entityRegions.get(filePath) ?? { filePath, items: [] };
      group.items.push({ index, cx: meta.cx, cz: meta.cz });
      entityRegions.set(filePath, group);
    }
    await mapWithConcurrency([...entityRegions.values()], MAX_PARALLEL_STORAGE_READS, async (group) => {
      const region = await readRegionHeader(group.filePath);
      if (!region) return;
      for (const item of group.items) {
        const meta = out[item.index];
        if (!meta || !hasRegionChunkHeader(region.header, item.cx & 31, item.cz & 31)) continue;
        meta.entityRevision = region.validator;
        meta.entitySourcePath = group.filePath;
        // Include entity revisions in source invalidation, independently of content digests.
        meta.sourceRevision = `v3:${sha256(new TextEncoder().encode(`${meta.sourceRevision}|${region.validator}`))}`;
      }
    });

    return out;
  }
  async function regionRevision(world: string, dim: string, rx: number, rz: number) {
    const dir = await regionDir(world, dim);
    const region = await worldStorage.stat(regionPathFromDir(dir, rx, rz));
    const inputs: (import('@violet-map/core/storage').StoredFileInfo | null)[] = [region];
    const files = await worldStorage.list(chunkOverrideDir(world, dim));
    if (files.length > 32768) throw new ResourceError('RESOURCE_BUSY', 'override inventory exceeds metadata budget');
    for (const file of files) {
      const match = CHUNK_RE.exec(file.path.split('/').pop() ?? '');
      if (match && Math.floor(Number(match[1]) / 32) === rx && Math.floor(Number(match[2]) / 32) === rz)
        inputs.push(file);
    }
    if (inputs.some((info) => info && (!info.etag || /^W\//i.test(info.etag)))) return undefined;
    return sha256(canonicalJson(inputs.map((info) => (info ? [info.path, info.size, info.etag] : null))));
  }
  async function readChunks(
    world: string,
    dim: string,
    chunks: { cx: number; cz: number }[],
  ): Promise<(ChunkReadResult | null)[]> {
    const generation = storageCacheGeneration;
    const metas = await inspectChunks(world, dim, chunks);
    const out = new Array<ChunkReadResult | null>(metas.length).fill(null);
    const cachedResults = new Uint8Array(metas.length);
    const byRegion = new Map<string, { meta: ChunkMetadata; index: number }[]>();

    await mapWithConcurrency(metas, MAX_PARALLEL_STORAGE_READS, async (meta, index) => {
      if (!meta.sourceRevision || !meta.terrainRevision || !meta.source || !meta.sourcePath || meta.missing) return;

      const cacheKey = chunkCacheKey(world, dim, meta.cx, meta.cz);
      const hit = chunkNbtCache.get(cacheKey);
      if (
        hit?.sourcePath === meta.sourcePath &&
        hit.terrainRevision === meta.terrainRevision &&
        hit.entityRevision === meta.entityRevision
      ) {
        out[index] = {
          ...meta,
          data: hit.data,
          entities: hit.entities,
          contentDigest: hit.contentDigest,
          terrainDigest: hit.terrainDigest,
          entityDigest: hit.entityDigest,
        } as ChunkReadResult;
        cachedResults[index] = 1;
        return;
      }

      if (meta.source === 'chunk') {
        const bytes = await readSource(meta.sourcePath);
        if (!bytes) throw new ResourceError('SOURCE_SNAPSHOT_CHANGED', 'chunk disappeared during read', true);
        const data = await decompressNbt(bytes);
        out[index] = { ...meta, data } as ChunkReadResult;
        return;
      }

      const group = byRegion.get(meta.sourcePath) ?? [];
      group.push({ meta, index });
      byRegion.set(meta.sourcePath, group);
    });

    await mapWithConcurrency([...byRegion.entries()], MAX_PARALLEL_STORAGE_READS, async ([filePath, items]) => {
      const data = await readRegionChunks(filePath, items);
      items.forEach(({ meta, index }, i) => {
        out[index] = { ...meta, data: data[i] } as ChunkReadResult;
      });
    });

    const byEntityRegion = new Map<string, { meta: ChunkMetadata; index: number }[]>();
    for (let index = 0; index < metas.length; index++) {
      const meta = metas[index];
      if (config.entities === false || cachedResults[index] || !out[index]?.data || !meta?.entitySourcePath) continue;
      const group = byEntityRegion.get(meta.entitySourcePath) ?? [];
      group.push({ meta, index });
      byEntityRegion.set(meta.entitySourcePath, group);
    }
    await mapWithConcurrency([...byEntityRegion.entries()], MAX_PARALLEL_STORAGE_READS, async ([filePath, items]) => {
      const data = await readRegionChunks(filePath, items, true);
      items.forEach(({ index }, i) => {
        out[index]!.entities = data[i];
      });
    });

    // Cache only after both terrain and optional entity NBT have been merged.
    for (let index = 0; index < out.length; index++) {
      if (cachedResults[index]) continue;
      const result = out[index];
      if (!result?.data || !result.sourcePath || !result.terrainRevision) continue;
      Object.assign(result, chunkIdentity(result.data, result.entities));
      if (generation !== storageCacheGeneration) continue;
      chunkNbtCache.set(chunkCacheKey(world, dim, result.cx, result.cz), {
        sourcePath: result.sourcePath,
        terrainRevision: result.terrainRevision,
        data: result.data,
        contentDigest: result.contentDigest,
        terrainDigest: result.terrainDigest,
        entityDigest: result.entityDigest,
        entityRevision: result.entityRevision,
        entities: result.entities,
      });
    }

    return out;
  }
  function cacheStats() {
    return {
      regions: regionCache.size,
      regionBytes: regionCache.weight,
      regionHeaders: regionHeaderCache.size,
      chunks: chunkNbtCache.size,
      chunkBytes: chunkNbtCache.weight,
      fileDigests: fileDigestCache.size,
      directories: regionDirCache.size + entityDirCache.size,
    };
  }
  return {
    cacheStats,
    listWorlds,
    listRegions,
    listChunkSourceCoverage,
    inspectChunks,
    readChunks,
    regionRevision,
    invalidateStoredFile,
    invalidateWorldList,
    invalidatePath,
    clearChunkCacheFor,
    clearWorldDirectoryCaches,
    clearWorldObjectCaches,
    regionDir,
    chunkOverrideDir,
    regionPathFromDir,
    readRegionFile,
    hasRegionChunk,
    hashFileInfo,
    readJson,
  };
}

export type WorldSource = ReturnType<typeof createWorldSource>;
