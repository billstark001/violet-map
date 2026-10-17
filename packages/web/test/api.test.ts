import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encode } from '@msgpack/msgpack';
import { fetchChunkHashes, fetchChunks } from '../src/api.js';

test('chunk endpoints encode dimensions containing path separators', async (t) => {
  const urls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    const bytes = encode({ chunks: [] });
    return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const world = 'example';
  const dim = 'mod:sky/islands';
  assert.deepEqual(await fetchChunkHashes(world, dim, [{ cx: 0, cz: 0 }]), []);
  assert.deepEqual(await fetchChunks(world, dim, [{ cx: 0, cz: 0 }]), []);
  assert.deepEqual(urls, [
    'http://localhost/api/worlds/example/mod%3Asky%2Fislands/chunk-hashes',
    'http://localhost/api/worlds/example/mod%3Asky%2Fislands/chunks',
  ]);
});

test('chunk batches propagate cancellation and reject malformed payloads instead of treating chunks as absent', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const controller = new AbortController();
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.signal, controller.signal);
    const bytes = encode({ chunks: 'invalid' });
    return new Response(bytes);
  };
  await assert.rejects(
    fetchChunks('world', 'overworld', [{ cx: 0, cz: 0 }], controller.signal),
    /invalid chunks response/,
  );
  globalThis.fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), {
        once: true,
      });
    });
  const request = fetchChunkHashes('world', 'overworld', [{ cx: 0, cz: 0 }], controller.signal);
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
});
