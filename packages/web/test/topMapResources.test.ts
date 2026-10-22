import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { encode } from '@msgpack/msgpack';
import { decodeTopMapManifest } from '../src/resources/topMapManifest.js';
import { fetchTopMapTile } from '../src/api.js';
import { TopMapRuntime } from '../src/runtime/topMapRuntime.js';
import { testView } from './helpers/scheduling.js';

const dimension = 'minecraft:overworld';

const fixture = (rx = 0) => ({
  schema: 6,
  kind: 'topmap-region',
  dimension,
  approach: 'top',
  region: { x: rx, z: 0 },
  origin: { x: rx * 512, z: 0 },
  size: { blocks: 512, samples: 1, colorSamples: 1, lightSamples: 1 },
  sampleStride: 512,
  colorStride: 512,
  lightStride: 512,
  chunks: 1,
  minY: 65,
  maxY: 65,
  heightEncoding: 'int16le',
  colorEncoding: 'rgba8888',
  lightEncoding: 'sky-block-u4',
  heights: new Uint8Array([65, 0]),
  colors: new Uint8Array([0, 255, 0, 255]),
  lights: new Uint8Array([15, 0]),
});

const ref = (bytes: Uint8Array) => ({
  digest: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length,
  mediaType: 'application/msgpack',
  format: 'topmap-msgpack-v6',
});

const head = {
  schemaVersion: 1,
  mode: 'server',
  viewId: 'a'.repeat(64),
  renderRoot: 'b'.repeat(64),
  sourceScope: 'topmap-fixture',
  generation: 0,
};

test('Top Map manifests require current artifact references and exact world/region identity', () => {
  const artifact = ref(encode(fixture()));
  const manifest = { world: 'world', dimension, hasTopMap: true, topMap: { regions: [{ x: 0, z: 0, artifact }] } };
  assert.equal(decodeTopMapManifest(manifest, 'world', dimension).get('0,0')!.artifact.digest, artifact.digest);
  assert.equal(decodeTopMapManifest({ world: 'world', dimension, hasTopMap: false }, 'world', dimension).size, 0);
  for (const invalid of [
    {},
    { ...manifest, world: 'another' },
    { ...manifest, topMap: undefined },
    { ...manifest, topMap: { regions: [] } },
    { ...manifest, topMap: { regions: [{ x: 0, z: 0 }] } },
    { ...manifest, topMap: { regions: [manifest.topMap.regions[0], manifest.topMap.regions[0]] } },
  ])
    assert.throws(() => decodeTopMapManifest(invalid, 'world', dimension), { code: 'UNSUPPORTED_RESOURCE_FORMAT' });
});

test('Top Map body admission checks the selected artifact before download and its region before display', async (t) => {
  let bytes = encode(fixture(1));
  let bodies = 0;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = String(input);
    if (url.includes('/views/current')) return Response.json(head);
    if (url.endsWith('/resolve'))
      return Response.json({
        viewId: head.viewId,
        validUntil: Date.now() + 30_000,
        resources: JSON.parse(init!.body as string).selectors.map((selector: unknown) => ({
          selector,
          resource: {
            schemaVersion: 1,
            kind: 'top-map-tile',
            artifact: ref(bytes),
            url: 'https://tiles.example/selected',
          },
        })),
      });
    bodies++;
    return new Response(bytes, { headers: { 'content-type': 'application/msgpack' } });
  });
  await assert.rejects(fetchTopMapTile('world', dimension, 0, 0, { ...ref(bytes), digest: 'f'.repeat(64) }), {
    code: 'RESOURCE_VIEW_EXPIRED',
  });
  assert.equal(bodies, 0);
  await assert.rejects(fetchTopMapTile('world', dimension, 0, 0, ref(bytes)), { code: 'UNSUPPORTED_RESOURCE_FORMAT' });
  assert.equal(bodies, 1);
  bytes = encode(fixture());
  const tile = await fetchTopMapTile('world', dimension, 0, 0, ref(bytes));
  assert.equal(tile.heights[0], 65);
  assert.equal(tile.payload.region.x, 0);
});

test('failed GPU publication releases the tile request and cannot publish CPU residency', async (t) => {
  const bytes = encode(fixture());
  const artifact = ref(bytes);
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = String(input);
    if (url.includes('/views/current')) return Response.json(head);
    if (url.includes('/top-map/manifest')) {
      const world = decodeURIComponent(new URL(url, 'http://localhost').pathname.split('/')[3]);
      return Response.json({ world, dimension, hasTopMap: true, topMap: { regions: [{ x: 0, z: 0, artifact }] } });
    }
    if (url.endsWith('/resolve'))
      return Response.json({
        viewId: head.viewId,
        validUntil: Date.now() + 30_000,
        resources: JSON.parse(init!.body as string).selectors.map((selector: unknown) => ({
          selector,
          resource: { schemaVersion: 1, kind: 'top-map-tile', artifact, url: 'https://tiles.example/selected' },
        })),
      });
    return new Response(bytes, { headers: { 'content-type': 'application/msgpack' } });
  });
  for (const stage of ['add', 'update']) {
    let removed = 0;
    const display = {
      setEnabled() {},
      setWanted() {},
      dispose() {},
      snapshot() {
        throw new Error('no resident');
      },
      add() {
        if (stage === 'add') throw new Error('GPU allocation failed');
      },
      update() {
        if (stage === 'update') throw new Error('GPU update failed');
      },
      remove() {
        removed++;
      },
    };
    const runtime = new TopMapRuntime(display, 96);
    t.after(() => runtime.dispose());
    runtime.configure('gpu-' + stage, dimension, true);
    await setImmediate();
    const state = runtime as any;
    assert.equal(runtime.diagnosticSnapshot().manifestLoaded, true);
    state.scheduler.plan({
      view: testView,
      now: 0,
      regions: state.regions,
      pending: new Set(),
      failed: new Map(),
      onlineChunks: new Set(),
    });
    await state.loadTile(0, 0, '0,0');
    assert.equal(removed, 1);
    assert.equal(state.tiles.size, 0);
    assert.equal(state.tileRequests.size, 0);
    assert.equal(state.failedTiles.has('0,0'), true);
    assert.throws(() => state.scheduler.residentSince('0,0'), /not registered/);
  }
});
