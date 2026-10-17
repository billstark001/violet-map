import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { LruCache } from '@violet-map/core/cache';
import { meshByteLength, type MeshBuffers } from '@violet-map/render';
import type { SectionMeshMsg } from './worker/protocol';

const DB_NAME = 'violet-map-mesh-cache';
const DB_VERSION = 7;
const STORE = 'meshes';
const MAX_ENTRIES = 1000;
const MAX_BYTES = 192 * 1024 * 1024;
const MAX_PENDING_WRITE_BYTES = 32 * 1024 * 1024;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 10 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_MEMORY_BYTES = 32 * 1024 * 1024;
const MAX_MEMORY_ENTRIES = 64;

type CacheMode = 'full' | 'lod';

interface MeshCacheRecord {
  key: string;
  world: string;
  dimension: string;
  renderKey: string;
  cx: number;
  cz: number;
  contentKey: string;
  mode: CacheMode;
  step: number;
  createdAt: number;
  accessedAt: number;
  bytes: number;
  full?: SectionMeshMsg[];
  lod?: MeshBuffers | null;
}

interface MeshCacheDb extends DBSchema {
  [STORE]: {
    key: string;
    value: MeshCacheRecord;
    indexes: { accessedAt: number; createdAt: number; bytes: number; accessedAtBytes: [number, number] };
  };
}

export interface MeshCacheKeyParts {
  world: string;
  dimension: string;
  renderKey: string;
  cx: number;
  cz: number;
  contentKey: string;
  mode: CacheMode;
  step?: number;
}

let dbPromise: Promise<IDBPDatabase<MeshCacheDb>> | undefined;
let cacheEnabled = true;
let cacheGeneration = 0;
// Mesh arrays are immutable after worker transfer. GPU geometry can share them
// with this small CPU cache; switching full/LOD or revisiting a chunk need not
// clone the same buffers out of IndexedDB on every request.
const memory = new LruCache<string, MeshCacheRecord>({
  maxEntries: MAX_MEMORY_ENTRIES,
  maxWeight: MAX_MEMORY_BYTES,
  weightOf: (record) => record.bytes,
});

function database() {
  if (!dbPromise) {
    const pending = openDB<MeshCacheDb>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        const store = db.objectStoreNames.contains(STORE)
          ? tx.objectStore(STORE)
          : db.createObjectStore(STORE, { keyPath: 'key' });
        // Old records counted view lengths and could hide large retained buffers.
        if (oldVersion > 0) store.clear();
        if (!store.indexNames.contains('accessedAt')) store.createIndex('accessedAt', 'accessedAt');
        if (!store.indexNames.contains('createdAt')) store.createIndex('createdAt', 'createdAt');
        if (!store.indexNames.contains('bytes')) store.createIndex('bytes', 'bytes');
        if (!store.indexNames.contains('accessedAtBytes'))
          store.createIndex('accessedAtBytes', ['accessedAt', 'bytes']);
      },
    });
    dbPromise = pending;
    void pending.catch(() => {
      if (dbPromise === pending) dbPromise = undefined;
    });
  }
  return dbPromise!;
}

/** Disabling this bypasses all mesh reads and writes without deleting existing cache data. */
export function setMeshCacheEnabled(enabled: boolean): void {
  if (!enabled && cacheEnabled) {
    cacheGeneration++;
    memory.clear();
  }
  cacheEnabled = enabled;
}

export function isMeshCacheEnabled(): boolean {
  return cacheEnabled;
}

let lastPrune = 0;
let pendingWriteBytes = 0;

function cacheKey(parts: MeshCacheKeyParts): string {
  return [
    parts.world,
    parts.dimension,
    parts.renderKey,
    parts.cx,
    parts.cz,
    parts.contentKey,
    parts.mode,
    parts.step ?? 0,
  ]
    .map(encodeURIComponent)
    .join('|');
}

function sectionBytes(sections: SectionMeshMsg[]): number {
  let total = 0;
  for (const section of sections) {
    for (const buffers of Object.values(section.layers)) {
      if (buffers) total += meshByteLength(buffers, 'retained');
    }
  }
  return total;
}

async function pruneCache() {
  const started = Date.now();
  if (started - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = started;
  try {
    const db = await database();
    const entries: { key: string; accessedAt: number; bytes: number }[] = [];
    const tx = db.transaction(STORE, 'readwrite');
    let cursor = await tx.store.index('accessedAtBytes').openKeyCursor();
    while (cursor) {
      const [accessedAt, bytes] = cursor.key as [number, number];
      const key = String(cursor.primaryKey);
      if (started - accessedAt > TTL_MS) await tx.store.delete(key);
      else entries.push({ key, accessedAt, bytes });
      cursor = await cursor.continue();
    }
    let totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    while (entries.length > MAX_ENTRIES || totalBytes > MAX_BYTES) {
      const oldest = entries.shift();
      if (!oldest) break;
      await tx.store.delete(oldest.key);
      totalBytes -= oldest.bytes;
    }
    await tx.done;
  } catch (error) {
    lastPrune = 0;
    throw error;
  }
}

async function touch<T extends MeshCacheRecord>(record: T): Promise<T> {
  if (Date.now() - record.accessedAt < TOUCH_INTERVAL_MS) return record;
  const generation = cacheGeneration;
  record.accessedAt = Date.now();
  const db = await database();
  if (cacheEnabled && generation === cacheGeneration) await db.put(STORE, record);
  return record;
}

async function putRecord(record: MeshCacheRecord): Promise<void> {
  if (!cacheEnabled) return;
  memory.set(record.key, record);
  const generation = cacheGeneration;
  const bytes = Math.max(0, record.bytes);
  if (bytes > MAX_PENDING_WRITE_BYTES) return;
  if (pendingWriteBytes + bytes > MAX_PENDING_WRITE_BYTES) return;
  pendingWriteBytes += bytes;
  try {
    const db = await database();
    if (!cacheEnabled || generation !== cacheGeneration) return;
    await db.put(STORE, record);
    await pruneCache();
  } finally {
    pendingWriteBytes = Math.max(0, pendingWriteBytes - bytes);
  }
}

export async function getCachedFull(parts: Omit<MeshCacheKeyParts, 'mode' | 'step'>): Promise<SectionMeshMsg[] | null> {
  if (!cacheEnabled) return null;
  const key = cacheKey({ ...parts, mode: 'full', step: 0 });
  const warm = memory.get(key);
  if (warm?.full && Date.now() - warm.accessedAt <= TTL_MS) {
    void touch(warm).catch(() => {});
    return warm.full;
  }
  memory.delete(key);
  const generation = cacheGeneration;
  const record = await (await database()).get(STORE, key);
  if (!cacheEnabled || generation !== cacheGeneration || !record?.full || Date.now() - record.accessedAt > TTL_MS)
    return null;
  const touched = await touch(record);
  if (!cacheEnabled || generation !== cacheGeneration) return null;
  memory.set(key, touched);
  return touched.full ?? null;
}

export async function putCachedFull(
  parts: Omit<MeshCacheKeyParts, 'mode' | 'step'>,
  sections: SectionMeshMsg[],
): Promise<void> {
  const now = Date.now();
  await putRecord({
    ...parts,
    key: cacheKey({ ...parts, mode: 'full', step: 0 }),
    mode: 'full',
    step: 0,
    createdAt: now,
    accessedAt: now,
    bytes: sectionBytes(sections),
    full: sections,
  });
}

export async function getCachedLod(
  parts: Omit<MeshCacheKeyParts, 'mode'> & { step: number },
): Promise<MeshBuffers | null | undefined> {
  if (!cacheEnabled) return undefined;
  const key = cacheKey({ ...parts, mode: 'lod' });
  const warm = memory.get(key);
  if (warm && Date.now() - warm.accessedAt <= TTL_MS) {
    void touch(warm).catch(() => {});
    return warm.lod;
  }
  memory.delete(key);
  const generation = cacheGeneration;
  const record = await (await database()).get(STORE, key);
  if (!cacheEnabled || generation !== cacheGeneration || !record || Date.now() - record.accessedAt > TTL_MS)
    return undefined;
  const touched = await touch(record);
  if (!cacheEnabled || generation !== cacheGeneration) return undefined;
  memory.set(key, touched);
  return touched.lod;
}

export async function putCachedLod(
  parts: Omit<MeshCacheKeyParts, 'mode'> & { step: number },
  lod: MeshBuffers | null,
): Promise<void> {
  const now = Date.now();
  await putRecord({
    ...parts,
    key: cacheKey({ ...parts, mode: 'lod' }),
    mode: 'lod',
    createdAt: now,
    accessedAt: now,
    bytes: lod ? meshByteLength(lod, 'retained') : 0,
    lod,
  });
}

export interface MeshCacheStats {
  entries: number;
  bytes: number;
}

export async function getMeshCacheStats(): Promise<MeshCacheStats> {
  if (!dbPromise) return { entries: 0, bytes: 0 };
  let entries = 0;
  let bytes = 0;
  const tx = (await database()).transaction(STORE);
  let cursor = await tx.store.index('bytes').openKeyCursor();
  while (cursor) {
    entries++;
    bytes += Number(cursor.key) || 0;
    cursor = await cursor.continue();
  }
  await tx.done;
  return { entries, bytes };
}

export async function clearMeshCache(): Promise<void> {
  cacheGeneration++;
  memory.clear();
  await (await database()).clear(STORE);
  lastPrune = 0;
}
