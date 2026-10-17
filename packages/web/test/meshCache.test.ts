import assert from 'node:assert/strict';
import { test } from 'node:test';
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
