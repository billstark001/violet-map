import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDB } from 'idb';
import { setImmediate } from 'node:timers/promises';
import {
  getCachedMesh,
  putCachedMesh,
  getMeshCacheStats,
  clearMeshCache,
  setMeshCacheEnabled,
  type CachedMesh,
} from '../src/meshCache.js';

const parts = {
  world: 'test',
  dimension: 'minecraft:overworld',
  renderKey: 'r',
  cx: 0,
  cz: 0,
  contentKey: 'c',
  mode: 'full' as const,
};
const data: CachedMesh = {
  mode: 'full',
  sections: [
    {
      sy: 0,
      layers: {
        opaque: {
          positions: new Uint16Array(12),
          uvs: new Uint16Array(8),
          colors: new Uint8Array(12),
          lights: new Uint8Array(8),
          indices: new Uint16Array(6),
        },
      },
    },
  ],
};

test('unavailable IndexedDB is a bounded cache miss and does not poison later opens', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
  try {
    assert.equal(await getCachedMesh(parts), undefined);
    assert.deepEqual(await getMeshCacheStats(), { entries: 0, bytes: 0 });
  } finally {
    if (previous) Object.defineProperty(globalThis, 'indexedDB', previous);
    else delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  }
});

test(
  'a blocked schema upgrade bypasses the cache and recovers after the old page closes',
  { timeout: 2000 },
  async (t) => {
    await import('fake-indexeddb/auto');
    const old = await openDB('violet-map-mesh-cache', 6, {
      upgrade(db) {
        db.createObjectStore('meshes', { keyPath: 'key' });
      },
    });
    t.after(() => old.close());
    await old.put('meshes', { key: 'obsolete', bytes: 1 });
    assert.equal(await getCachedMesh(parts), undefined);
    assert.equal(await getCachedMesh(parts), undefined);
    old.close();
    for (let attempt = 0; attempt < 20; attempt++) {
      await setImmediate();
      try {
        await putCachedMesh(parts, data);
        break;
      } catch {
        if (attempt === 19) throw Error('cache did not recover');
      }
    }
    assert.deepEqual(await getCachedMesh(parts), data);
    assert.equal((await getMeshCacheStats()).entries, 1);
    await clearMeshCache();
  },
);

test('one mesh cache API preserves empty LOD, shares warm buffers and accounts metadata without reading geometry', async () => {
  await import('fake-indexeddb/auto');
  await clearMeshCache();
  setMeshCacheEnabled(true);
  await putCachedMesh(parts, data);
  assert.equal(await getCachedMesh(parts), data);
  const lod = { ...parts, mode: 'lod' as const, step: 8 };
  assert.equal(await getCachedMesh(lod), undefined);
  await putCachedMesh(lod, { mode: 'lod', mesh: null });
  assert.deepEqual(await getCachedMesh(lod), { mode: 'lod', mesh: null });
  assert.deepEqual(await getMeshCacheStats(), { entries: 2, bytes: 72 });
  setMeshCacheEnabled(false);
  assert.equal(await getCachedMesh(parts), undefined);
  assert.deepEqual(await getMeshCacheStats(), { entries: 0, bytes: 0 });
  setMeshCacheEnabled(true);
  const cold = await getCachedMesh(parts);
  assert.deepEqual(cold, data);
  assert.notEqual(cold, data);
  await clearMeshCache();
  assert.equal(await getCachedMesh(parts), undefined);
  assert.deepEqual(await getMeshCacheStats(), { entries: 0, bytes: 0 });
});

test('retained backing bytes bound the memory cache and pending writes', async () => {
  const backing = new ArrayBuffer(36 * 1024 ** 2);
  const large: CachedMesh = {
    mode: 'lod',
    mesh: {
      positions: new Uint16Array(backing, 0, 3),
      colors: new Uint8Array(backing, 16, 3),
      lights: new Uint8Array(backing, 24, 2),
      indices: new Uint16Array(backing, 32, 3),
    },
  };
  const lod = { ...parts, mode: 'lod' as const, step: 2 };
  await putCachedMesh(lod, large);
  assert.equal(
    await getCachedMesh(lod),
    undefined,
    'oversize backing fits neither memory nor the pending write budget',
  );
  assert.deepEqual(await getMeshCacheStats(), { entries: 0, bytes: 0 });
});

test('aborted requests and transactions are both observed without unhandled rejections', async () => {
  await clearMeshCache();
  const put = IDBObjectStore.prototype.put;
  const get = IDBObjectStore.prototype.get;
  try {
    IDBObjectStore.prototype.put = function (...args) {
      const request = put.apply(this, args);
      this.transaction.abort();
      return request;
    };
    await assert.rejects(putCachedMesh(parts, data), { name: 'AbortError' });
    setMeshCacheEnabled(false);
    setMeshCacheEnabled(true);
    IDBObjectStore.prototype.get = function (...args) {
      const request = get.apply(this, args);
      this.transaction.abort();
      return request;
    };
    assert.equal(await getCachedMesh(parts), undefined);
    await setImmediate();
  } finally {
    IDBObjectStore.prototype.put = put;
    IDBObjectStore.prototype.get = get;
    await clearMeshCache();
  }
});

test('refreshing access writes only usage metadata and extends cold-read TTL', async (t) => {
  await clearMeshCache();
  const start = Date.now();
  let now = start;
  t.mock.method(Date, 'now', () => now);
  await putCachedMesh(parts, data);
  const stores: string[] = [];
  const put = IDBObjectStore.prototype.put;
  const mocked = t.mock.method(IDBObjectStore.prototype, 'put', function (...args) {
    stores.push(this.name);
    return put.apply(this, args);
  });
  now += 7 * 24 * 60 * 60 * 1000 - 60000;
  assert.deepEqual(await getCachedMesh(parts), data);
  await getMeshCacheStats();
  assert.deepEqual(stores, ['usage']);
  mocked.mock.restore();
  setMeshCacheEnabled(false);
  setMeshCacheEnabled(true);
  now += 120000;
  assert.deepEqual(await getCachedMesh(parts), data, 'fresh usage survives an expired geometry creation time');
  await clearMeshCache();
});
