import { LOD_STEPS, type LodStep, type TerrainMesh } from '../view/terrain';
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { LruCache } from '@violet-map/core/cache';
import { meshByteLength } from '@violet-map/render';

const DB_NAME = 'violet-map-mesh-cache';
const STORE = 'meshes';
const USAGE = 'usage';
const MAX_ENTRIES = 1000;
const MAX_BYTES = 192 * 1024 ** 2;
const MAX_PENDING_WRITE_BYTES = 32 * 1024 ** 2;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 10000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const READ_DEADLINE_MS = 150;
const TRANSACTION_DEADLINE_MS = 1000;

export interface MeshCacheKeyParts {
  world: string;
  dimension: string;
  renderKey: string;
  cx: number;
  cz: number;
  contentKey: string;
  step: LodStep;
}

interface Usage {
  key: string;
  accessedAt: number;
  bytes: number;
}

interface MeshCacheRecord extends Usage {
  data: TerrainMesh;
}

interface MeshCacheDb extends DBSchema {
  meshes: { key: string; value: { key: string; data: TerrainMesh } };
  usage: { key: string; value: Usage };
}

export interface MeshCacheStats {
  entries: number;
  bytes: number;
}

let dbPromise: Promise<IDBPDatabase<MeshCacheDb>> | undefined;
let cacheEnabled = true;
let cacheGeneration = 0;
let pendingWriteBytes = 0;
let pendingWrites = 0;
let lastPrune = 0;
let pruning: Promise<void> | undefined;
let statsPending: Promise<MeshCacheStats> | undefined;
const memory = new LruCache<string, MeshCacheRecord>({
  maxEntries: 64,
  maxWeight: 32 * 1024 ** 2,
  weightOf: (r) => r.bytes,
});

function database() {
  if (!dbPromise) {
    let ready: Promise<IDBPDatabase<MeshCacheDb>> | undefined;
    let rejectBlocked!: (error: Error) => void;
    const blocked = new Promise<never>((_, reject) => {
      rejectBlocked = reject;
    });
    const invalidate = () => {
      if (dbPromise === pending || dbPromise === ready) dbPromise = undefined;
    };
    const opening = openDB<MeshCacheDb>(DB_NAME, 8, {
      upgrade(db) {
        // Cached meshes are disposable: replace the schema instead of keeping
        // old formats or scanning large geometry records for accounting.
        for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
        db.createObjectStore(STORE, { keyPath: 'key' });
        db.createObjectStore(USAGE, { keyPath: 'key' });
      },
      blocked() {
        rejectBlocked(new Error('mesh cache upgrade is blocked by another page'));
      },
      blocking(_current, _next, event) {
        (event.target as IDBDatabase).close();
        invalidate();
      },
      terminated: invalidate,
    });
    const pending = Promise.race([opening, blocked]);
    dbPromise = pending;
    void opening.then((db) => {
      ready = Promise.resolve(db);
      if (dbPromise === pending) dbPromise = ready;
    }, invalidate);
  }
  return dbPromise!;
}

function deadline<T>(promise: Promise<T>, ms: number, abort?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      abort?.();
      reject(new Error('mesh cache operation timed out'));
    }, ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function transaction<T>(
  tx: { done: Promise<unknown>; abort(): void },
  operation: () => Promise<T>,
  ms = TRANSACTION_DEADLINE_MS,
): Promise<T> {
  // Observe both requests and transaction completion, including when a
  // deadline aborts them. Neither rejection may escape this optional cache.
  return deadline(
    Promise.all([Promise.resolve().then(operation), tx.done]).then(([result]) => result),
    ms,
    () => {
      try {
        tx.abort();
      } catch {
        /* completed */
      }
    },
  );
}

function cacheKey(parts: MeshCacheKeyParts) {
  if (!LOD_STEPS.includes(parts.step)) throw new RangeError('invalid mesh cache LOD step');
  return [
    parts.world,
    parts.dimension,
    parts.renderKey,
    parts.cx,
    parts.cz,
    parts.contentKey,
    parts.step === 1 ? 'full' : 'lod',
    parts.step === 1 ? 0 : parts.step,
  ]
    .map(encodeURIComponent)
    .join('|');
}

function byteLength(data: TerrainMesh) {
  return data.mode === 'lod'
    ? data.mesh
      ? meshByteLength(data.mesh, 'retained')
      : 0
    : data.sections.reduce(
        (total, s) =>
          total + Object.values(s.layers).reduce((sum, b) => sum + (b ? meshByteLength(b, 'retained') : 0), 0),
        0,
      );
}

async function metadata(): Promise<Usage[]> {
  const db = await deadline(database(), READ_DEADLINE_MS);
  const tx = db.transaction(USAGE);
  return transaction(tx, () => tx.store.getAll(), READ_DEADLINE_MS);
}

async function write(record: Usage & { data?: TerrainMesh }, generation = cacheGeneration): Promise<boolean> {
  const retainedBytes = record.data ? record.bytes : 128;
  if (
    !cacheEnabled ||
    pendingWrites >= 32 ||
    retainedBytes > MAX_PENDING_WRITE_BYTES ||
    pendingWriteBytes > MAX_PENDING_WRITE_BYTES - retainedBytes
  )
    return false;
  pendingWriteBytes += retainedBytes;
  pendingWrites++;
  try {
    const db = await deadline(database(), READ_DEADLINE_MS);
    if (!cacheEnabled || generation !== cacheGeneration) return false;
    const tx = db.transaction(record.data ? [STORE, USAGE] : [USAGE], 'readwrite');
    await transaction(tx, async () => {
      if (record.data) await tx.objectStore(STORE).put({ key: record.key, data: record.data });
      await tx.objectStore(USAGE).put({ key: record.key, accessedAt: record.accessedAt, bytes: record.bytes });
    });
    return true;
  } finally {
    pendingWriteBytes -= retainedBytes;
    pendingWrites--;
  }
}

async function pruneCache() {
  if (pruning) return pruning;
  const now = Date.now();
  if (now - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = now;
  const generation = cacheGeneration;
  const task = (async () => {
    const entries = (await metadata()).sort((a, b) => a.accessedAt - b.accessedAt);
    let bytes = entries.reduce((sum, r) => sum + r.bytes, 0);
    let count = entries.length;
    const victims = entries.filter((r) => {
      if (now - r.accessedAt <= TTL_MS && count <= MAX_ENTRIES && bytes <= MAX_BYTES) return false;
      count--;
      bytes -= r.bytes;
      return true;
    });
    const db = await deadline(database(), READ_DEADLINE_MS);
    for (let i = 0; i < victims.length && generation === cacheGeneration; i += 32) {
      const tx = db.transaction([STORE, USAGE], 'readwrite');
      await transaction(tx, async () => {
        for (const r of victims.slice(i, i + 32)) {
          await tx.objectStore(STORE).delete(r.key);
          await tx.objectStore(USAGE).delete(r.key);
        }
      });
    }
  })();
  pruning = task;
  try {
    await task;
  } catch (error) {
    lastPrune = 0;
    throw error;
  } finally {
    if (pruning === task) pruning = undefined;
  }
}

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

/** Optional storage has a bounded latency and never owns a worker execution slot. */
export async function getCachedMesh(parts: MeshCacheKeyParts): Promise<TerrainMesh | undefined> {
  const key = cacheKey(parts);
  if (!cacheEnabled) return undefined;
  const generation = cacheGeneration;
  let record = memory.get(key);
  if (!record) {
    try {
      const db = await deadline(database(), READ_DEADLINE_MS);
      const tx = db.transaction([STORE, USAGE]);
      record = await transaction(
        tx,
        async () => {
          const usage = await tx.objectStore(USAGE).get(key);
          if (!usage || Date.now() - usage.accessedAt > TTL_MS) return undefined;
          const mesh = await tx.objectStore(STORE).get(key);
          return mesh && usage ? { ...usage, data: mesh.data } : undefined;
        },
        READ_DEADLINE_MS,
      );
    } catch {
      return undefined;
    }
  }
  if (!cacheEnabled || generation !== cacheGeneration || !record || Date.now() - record.accessedAt > TTL_MS)
    return undefined;
  memory.set(key, record);
  if (Date.now() - record.accessedAt > TOUCH_INTERVAL_MS) {
    record.accessedAt = Date.now();
    void write({ key, accessedAt: record.accessedAt, bytes: record.bytes }).catch(() => {});
  }
  return record.data;
}

export async function putCachedMesh(parts: MeshCacheKeyParts, data: TerrainMesh): Promise<void> {
  const key = cacheKey(parts);
  if ((parts.step === 1 ? 'full' : 'lod') !== data.mode) throw new Error('mesh cache representation mismatch');
  if (!cacheEnabled) return;
  const record = { key, accessedAt: Date.now(), bytes: byteLength(data), data };
  memory.set(record.key, record);
  const generation = cacheGeneration;
  if (await write(record, generation)) await pruneCache();
}

export async function getMeshCacheStats(): Promise<MeshCacheStats> {
  if (!cacheEnabled || !dbPromise) return { entries: 0, bytes: 0 };
  if (statsPending) return statsPending;
  const task = metadata().then((rows) => ({ entries: rows.length, bytes: rows.reduce((sum, r) => sum + r.bytes, 0) }));
  statsPending = task;
  try {
    return await task;
  } finally {
    if (statsPending === task) statsPending = undefined;
  }
}

export async function clearMeshCache(): Promise<void> {
  cacheGeneration++;
  memory.clear();
  lastPrune = 0;
  const db = await deadline(database(), READ_DEADLINE_MS);
  const tx = db.transaction([STORE, USAGE], 'readwrite');
  await transaction(tx, async () => {
    await tx.objectStore(STORE).clear();
    await tx.objectStore(USAGE).clear();
  });
}
