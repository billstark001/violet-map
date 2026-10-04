import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encode } from '@msgpack/msgpack';
import { fetchChunk, fetchChunkHashes, fetchChunks } from '../src/api.js';

test('chunk endpoints encode dimensions containing path separators', async (t) => {
  const urls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    if (String(input).includes('/chunk/')) return new Response(null, { status: 204 });
    const bytes = encode({ chunks: [] });
    return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const world = 'example';
  const dim = 'mod:sky/islands';
  assert.equal(await fetchChunk(world, dim, 0, 0), null);
  assert.deepEqual(await fetchChunkHashes(world, dim, [{ cx: 0, cz: 0 }]), []);
  assert.deepEqual(await fetchChunks(world, dim, [{ cx: 0, cz: 0 }]), []);
  assert.deepEqual(urls, [
    '/api/worlds/example/mod%3Asky%2Fislands/chunk/0/0',
    '/api/worlds/example/mod%3Asky%2Fislands/chunk-hashes',
    '/api/worlds/example/mod%3Asky%2Fislands/chunks',
  ]);
});
