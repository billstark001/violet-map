import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeChunkCoverage } from '../src/resources/chunkCoverage.js';
import { ChunkRuntime } from '../src/runtime/chunkRuntime.js';

const mask = new Uint8Array(128);

mask[127] = 128;

const encoded = Buffer.from(mask).toString('base64');

test('source coverage requires exact masks, including negative coordinates and direct overrides', () => {
  const coverage = decodeChunkCoverage({ regions: [{ x: -1, z: -1, mask: encoded }], chunks: [{ cx: 0, cz: 0 }] });
  const runtime = Object.assign(Object.create(ChunkRuntime.prototype), { chunkCoverage: coverage });
  assert.equal(runtime.hasChunkSourceAt(-1, -1), true);
  assert.equal(runtime.hasChunkSourceAt(-2, -1), false);
  assert.equal(runtime.hasChunkSourceAt(0, 0), true);
  assert.equal(runtime.hasChunkSourceAt(100, 100), false);
  for (const invalid of [
    null,
    {},
    { regions: [] },
    { regions: [{ x: -1, z: -1 }], chunks: [] },
    { regions: [{ x: -1, z: -1, mask: 'broken' }], chunks: [] },
    { regions: [{ x: -1, z: -1, mask: encoded.slice(1) }], chunks: [] },
    {
      regions: [
        { x: -1, z: -1, mask: encoded },
        { x: -1, z: -1, mask: encoded },
      ],
      chunks: [],
    },
    { regions: [], chunks: [{ cx: 0.5, cz: 0 }] },
  ])
    assert.throws(() => decodeChunkCoverage(invalid), { code: 'UNSUPPORTED_RESOURCE_FORMAT' });
});

test('a malformed region cannot silently mark its generated chunks absent', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input) => {
    if (String(input).includes('/views/current'))
      return Response.json({
        schemaVersion: 1,
        viewId: 'a'.repeat(64),
        mode: 'server',
        sourceScope: 'coverage-fixture',
        generation: 0,
        renderRoot: 'b'.repeat(64),
      });
    return Response.json({
      regions: [
        { x: -1, z: -1, mask: encoded },
        { x: 0, z: 0, mask: 'broken' },
      ],
      chunks: [],
    });
  });
  const entry = { key: 'known', cx: 0, cz: 0, state: 'stored', contentDigest: 'known' };
  const runtime = Object.assign(Object.create(ChunkRuntime.prototype), {
    opts: { world: 'world', dimension: 'minecraft:overworld' },
    requests: new AbortController(),
    disposed: false,
    coverageSeq: 0,
    chunks: new Map([[entry.key, entry]]),
  });
  await runtime.loadChunkSourceCoverage();
  assert.match(runtime.coverageError, /invalid chunk source coverage/);
  assert.equal(runtime.hasChunkSourceAt(0, 0), null, 'unverified coverage must leave source presence unknown');
  assert.equal(entry.state, 'stored');
  assert.equal(entry.contentDigest, 'known');
});
