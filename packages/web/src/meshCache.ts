import { openDB, type DBSchema } from 'idb';
import type { MeshBuffers, RenderLayer } from '@violet-map/core';
import type { SectionMeshMsg } from './worker/protocol';

const DB_NAME = 'violet-map-mesh-cache';
const DB_VERSION = 2;
const STORE = 'meshes';
const MAX_ENTRIES = 1600;
const MAX_BYTES = 384 * 1024 * 1024;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

type CacheMode = 'full' | 'lod';

interface MeshCacheRecord {
  key: string;
  world: string;
  dimension: string;
  renderKey: string;
  cx: number;
  cz: number;
  sourceHash: string;
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
    indexes: { accessedAt: number; createdAt: number };
  };
}

export interface MeshCacheKeyParts {
  world: string;
  dimension: string;
  renderKey: string;
  cx: number;
  cz: number;
  sourceHash: string;
  mode: CacheMode;
  step?: number;
}

const dbPromise = openDB<MeshCacheDb>(DB_NAME, DB_VERSION, {
  upgrade(db, oldVersion) {
    if (oldVersion > 0 && db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
    const store = db.createObjectStore(STORE, { keyPath: 'key' });
    store.createIndex('accessedAt', 'accessedAt');
    store.createIndex('createdAt', 'createdAt');
  },
});
let lastPrune = 0;

function cacheKey(parts: MeshCacheKeyParts): string {
  return [
    parts.world,
    parts.dimension,
    parts.renderKey,
    parts.cx,
    parts.cz,
    parts.sourceHash,
    parts.mode,
    parts.step ?? 0,
  ].map(encodeURIComponent).join('|');
}

function bufferBytes(b: MeshBuffers): number {
  return b.positions.byteLength + b.uvs.byteLength + b.colors.byteLength + b.lights.byteLength + b.indices.byteLength;
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
  let entries = await db.getAllFromIndex(STORE, 'accessedAt');
  await Promise.all(entries.filter((e) => started - e.accessedAt > TTL_MS).map((e) => db.delete(STORE, e.key)));
  entries = entries.filter((e) => started - e.accessedAt <= TTL_MS);
  let totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  while (entries.length > MAX_ENTRIES || totalBytes > MAX_BYTES) {
    const oldest = entries.shift();
    if (!oldest) break;
    await db.delete(STORE, oldest.key);
    totalBytes -= oldest.bytes;
  }
}

async function touch<T extends MeshCacheRecord>(record: T): Promise<T> {
  if (Date.now() - record.accessedAt < TOUCH_INTERVAL_MS) return record;
  record.accessedAt = Date.now();
  await (await dbPromise).put(STORE, record);
  return record;
}

export async function getCachedFull(parts: Omit<MeshCacheKeyParts, 'mode' | 'step'>): Promise<SectionMeshMsg[] | null> {
  const record = await (await dbPromise).get(STORE, cacheKey({ ...parts, mode: 'full', step: 0 }));
  if (!record || !record.full || Date.now() - record.accessedAt > TTL_MS) return null;
  return (await touch(record)).full ?? null;
}

export async function putCachedFull(parts: Omit<MeshCacheKeyParts, 'mode' | 'step'>, sections: SectionMeshMsg[]): Promise<void> {
  const now = Date.now();
  await (await dbPromise).put(STORE, {
    ...parts,
    key: cacheKey({ ...parts, mode: 'full', step: 0 }),
    mode: 'full',
    step: 0,
    createdAt: now,
    accessedAt: now,
    bytes: sectionBytes(sections),
    full: sections,
  });
  await pruneCache();
}

export async function getCachedLod(parts: Omit<MeshCacheKeyParts, 'mode'> & { step: number }): Promise<MeshBuffers | null | undefined> {
  const record = await (await dbPromise).get(STORE, cacheKey({ ...parts, mode: 'lod' }));
  if (!record || Date.now() - record.accessedAt > TTL_MS) return undefined;
  return (await touch(record)).lod;
}

export async function putCachedLod(parts: Omit<MeshCacheKeyParts, 'mode'> & { step: number }, lod: MeshBuffers | null): Promise<void> {
  const now = Date.now();
  await (await dbPromise).put(STORE, {
    ...parts,
    key: cacheKey({ ...parts, mode: 'lod' }),
    mode: 'lod',
    createdAt: now,
    accessedAt: now,
    bytes: lod ? bufferBytes(lod) : 0,
    lod,
  });
  await pruneCache();
}

export interface MeshCacheStats {
  entries: number;
  bytes: number;
}

export async function getMeshCacheStats(): Promise<MeshCacheStats> {
  const entries = await (await dbPromise).getAll(STORE);
  return {
    entries: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
  };
}

export async function clearMeshCache(): Promise<void> {
  await (await dbPromise).clear(STORE);
  lastPrune = 0;
}
