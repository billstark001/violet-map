import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDB } from 'idb';
import { setImmediate } from 'node:timers/promises';
import { getCachedFull, getMeshCacheStats } from '../src/meshCache.js';

test('a failed IndexedDB open does not leave a permanent rejected database promise', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
  try {
    await assert.rejects(
      getCachedFull({ world: 'test', dimension: 'minecraft:overworld', renderKey: 'r', cx: 0, cz: 0, contentKey: 'c' }),
    );
    assert.deepEqual(await getMeshCacheStats(), { entries: 0, bytes: 0 });
  } finally {
    if (previous) Object.defineProperty(globalThis, 'indexedDB', previous);
    else delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  }
});

test('a blocked upgrade fails promptly and recovers after the old page closes', { timeout: 2000 }, async (t) => {
  await import('fake-indexeddb/auto');
  const old = await openDB('violet-map-mesh-cache', 6, {
    upgrade(db) {
      db.createObjectStore('meshes', { keyPath: 'key' });
    },
  });
  t.after(() => old.close());
  await old.put('meshes', { key: 'obsolete', bytes: 1 });
  const parts = { world: 'upgrade', dimension: 'overworld', renderKey: 'r', cx: 0, cz: 0, contentKey: 'c' };
  await assert.rejects(getCachedFull(parts), /blocked by another page/);
  await assert.rejects(getCachedFull(parts), /blocked by another page/);
  old.close();
  let recovered = false;
  for (let attempt = 0; attempt < 20 && !recovered; attempt++) {
    await setImmediate();
    try {
      assert.equal(await getCachedFull(parts), null);
      recovered = true;
    } catch (error) {
      assert.match(String(error), /blocked by another page/);
    }
  }
  assert.equal(recovered, true);
  assert.deepEqual(await getMeshCacheStats(), { entries: 0, bytes: 0 });
});

test('warm mesh buffers are reused, cold reads remain isolated, and disable/clear release memory residents', async () => {
  await import('fake-indexeddb/auto');
  const { clearMeshCache, getCachedLod, putCachedFull, putCachedLod, setMeshCacheEnabled } =
    await import('../src/meshCache.js');
  const parts = { world: 'warm', dimension: 'minecraft:overworld', renderKey: 'r', cx: 0, cz: 0, contentKey: 'c' };
  const sections = [
    {
      sy: 0,
      visibility: 0,
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
  ];
  await clearMeshCache();
  try {
    await putCachedFull(parts, sections);
    assert.equal(await getCachedFull(parts), sections, 'warm reads must share immutable buffers');
    assert.equal(await getCachedFull({ ...parts, contentKey: 'changed' }), null);
    await putCachedLod({ ...parts, step: 2 }, null);
    assert.equal(await getCachedLod({ ...parts, step: 2 }), null, 'empty LOD is a hit, not a miss');
    setMeshCacheEnabled(false);
    assert.equal(await getCachedFull(parts), null);
    assert.equal(await getCachedLod({ ...parts, step: 2 }), undefined);
    setMeshCacheEnabled(true);
    const cold = await getCachedFull(parts);
    assert.notEqual(cold, sections, 'disabling releases memory without deleting persistent records');
    assert.deepEqual(cold, sections);
    assert.equal(await getCachedFull(parts), cold, 'cold reads populate memory for the next request');
    await clearMeshCache();
    assert.equal(await getCachedFull(parts), null);
    assert.equal(await getCachedLod({ ...parts, step: 2 }), undefined);
  } finally {
    setMeshCacheEnabled(true);
    await clearMeshCache();
  }
});

test('warm memory mesh retention evicts old keys even for empty meshes', async () => {
  await import('fake-indexeddb/auto');
  const { clearMeshCache, putCachedFull } = await import('../src/meshCache.js');
  const parts = { world: 'bounded', dimension: 'minecraft:overworld', renderKey: 'r', cx: 0, cz: 0, contentKey: 'c' };
  const first: import('../src/worker/protocol.js').SectionMeshMsg[] = [];
  await clearMeshCache();
  try {
    await putCachedFull(parts, first);
    let last: import('../src/worker/protocol.js').SectionMeshMsg[] = [];
    for (let cx = 1; cx <= 64; cx++) {
      last = [];
      await putCachedFull({ ...parts, cx }, last);
    }
    assert.equal(await getCachedFull({ ...parts, cx: 64 }), last);
    assert.notEqual(await getCachedFull(parts), first, 'an evicted mesh must be read as a new IDB clone');
  } finally {
    await clearMeshCache();
  }
});

test('mesh caches count retained capacity instead of tiny views into oversized buffers', async () => {
  await import('fake-indexeddb/auto');
  const { clearMeshCache, putCachedFull } = await import('../src/meshCache.js');
  const parts = { world: 'backing', dimension: 'overworld', renderKey: 'r', cx: 0, cz: 0, contentKey: 'c' };
  const makeSections = () => {
    const buffer = new ArrayBuffer(9 * 1024 ** 2);
    return [
      {
        sy: 0,
        visibility: 0,
        layers: {
          opaque: {
            positions: new Uint16Array(buffer, 0, 3),
            colors: new Uint8Array(buffer, 6, 3),
            lights: new Uint8Array(buffer, 9, 2),
            indices: new Uint16Array(buffer, 12, 3),
          },
        },
      },
    ];
  };
  await clearMeshCache();
  try {
    const first = makeSections();
    await putCachedFull(parts, first);
    let last = first;
    for (let cx = 1; cx <= 3; cx++) {
      last = makeSections();
      await putCachedFull({ ...parts, cx }, last);
    }
    assert.equal(await getCachedFull({ ...parts, cx: 3 }), last);
    assert.notEqual(await getCachedFull(parts), first, '36 MiB of backing exceeds the 32 MiB memory cache');
    assert.equal((await getMeshCacheStats()).bytes, 36 * 1024 ** 2, 'shared attributes count their backing only once');
  } finally {
    await clearMeshCache();
  }
});
