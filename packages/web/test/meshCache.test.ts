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
