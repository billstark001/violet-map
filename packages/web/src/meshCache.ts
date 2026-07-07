import { openDB, type DBSchema } from 'idb';
import type { MeshBuffers } from '@violet-map/core';
import type { SectionMeshMsg } from './worker/protocol';

const DB_NAME = 'violet-map-mesh-cache';
const DB_VERSION = 5;
const STORE = 'meshes';
const MAX_ENTRIES = 1000;
const MAX_BYTES = 192 * 1024 * 1024;
const MAX_PENDING_WRITE_BYTES = 32 * 1024 * 1024;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 10 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

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

const dbPromise = openDB<MeshCacheDb>(DB_NAME, DB_VERSION, {
  upgrade(db, _oldVersion, _newVersion, tx) {
    const store = db.objectStoreNames.contains(STORE)
      ? tx.objectStore(STORE)
      : db.createObjectStore(STORE, { keyPath: 'key' });
    if (!store.indexNames.contains('accessedAt')) store.createIndex('accessedAt', 'accessedAt');
    if (!store.indexNames.contains('createdAt')) store.createIndex('createdAt', 'createdAt');
    if (!store.indexNames.contains('bytes')) store.createIndex('bytes', 'bytes');
    if (!store.indexNames.contains('accessedAtBytes')) store.createIndex('accessedAtBytes', ['accessedAt', 'bytes']);
  },
});
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
  ].map(encodeURIComponent).join('|');
}

function bufferBytes(b: MeshBuffers): number {
  return b.positions.byteLength + (b.uvs?.byteLength ?? 0) + (b.atlasRects?.byteLength ?? 0)
    + b.colors.byteLength + b.lights.byteLength + b.indices.byteLength;
}

function sectionBytes(sections: SectionMeshMsg[]): number {
  let total = 0;
  for (const section of sections) {
    for (const buffers of Object.values(section.layers)) {
      if (buffers) total += bufferBytes(buffers);
    }
  }
  return total;
}

async function pruneCache() {
  const started = Date.now();
  if (started - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = started;
  const db = await dbPromise;
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
}

async function touch<T extends MeshCacheRecord>(record: T): Promise<T> {
  if (Date.now() - record.accessedAt < TOUCH_INTERVAL_MS) return record;
  record.accessedAt = Date.now();
  await (await dbPromise).put(STORE, record);
  return record;
}

async function putRecord(record: MeshCacheRecord): Promise<void> {
  const bytes = Math.max(0, record.bytes);
  if (bytes > MAX_PENDING_WRITE_BYTES) return;
  if (pendingWriteBytes + bytes > MAX_PENDING_WRITE_BYTES) return;
  pendingWriteBytes += bytes;
  try {
    await (await dbPromise).put(STORE, record);
    await pruneCache();
  } finally {
    pendingWriteBytes = Math.max(0, pendingWriteBytes - bytes);
  }
}

export async function getCachedFull(parts: Omit<MeshCacheKeyParts, 'mode' | 'step'>): Promise<SectionMeshMsg[] | null> {
  const record = await (await dbPromise).get(STORE, cacheKey({ ...parts, mode: 'full', step: 0 }));
  if (!record || !record.full || Date.now() - record.accessedAt > TTL_MS) return null;
  return (await touch(record)).full ?? null;
}

export async function putCachedFull(parts: Omit<MeshCacheKeyParts, 'mode' | 'step'>, sections: SectionMeshMsg[]): Promise<void> {
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

export async function getCachedLod(parts: Omit<MeshCacheKeyParts, 'mode'> & { step: number }): Promise<MeshBuffers | null | undefined> {
  const record = await (await dbPromise).get(STORE, cacheKey({ ...parts, mode: 'lod' }));
  if (!record || Date.now() - record.accessedAt > TTL_MS) return undefined;
  return (await touch(record)).lod;
}

export async function putCachedLod(parts: Omit<MeshCacheKeyParts, 'mode'> & { step: number }, lod: MeshBuffers | null): Promise<void> {
  const now = Date.now();
  await putRecord({
    ...parts,
    key: cacheKey({ ...parts, mode: 'lod' }),
    mode: 'lod',
    createdAt: now,
    accessedAt: now,
    bytes: lod ? bufferBytes(lod) : 0,
    lod,
  });
}

export interface MeshCacheStats {
  entries: number;
  bytes: number;
}

export async function getMeshCacheStats(): Promise<MeshCacheStats> {
  let entries = 0;
  let bytes = 0;
  const tx = (await dbPromise).transaction(STORE);
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
  await (await dbPromise).clear(STORE);
  lastPrune = 0;
}
