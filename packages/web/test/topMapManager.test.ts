import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import * as THREE from 'three';
import { TopMapManager } from '../src/scheduling/topMapManager.js';

test('a transient manifest failure is retried on a later update', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input) => {
    if (String(input).includes('/views/current'))
      return Response.json({
        schemaVersion: 1,
        viewId: 'a'.repeat(64),
        mode: 'server',
        sourceScope: 'fixture',
        generation: 0,
        renderRoot: 'b'.repeat(64),
      });
    calls++;
    if (calls === 1) throw new Error('temporary outage');
    return Response.json({ hasTopMap: false, world: 'world', dimension: 'minecraft:overworld' });
  };
  const manager = new TopMapManager(new THREE.Scene(), {} as never);
  try {
    manager.configure('world', 'minecraft:overworld', true);
    await setImmediate();
    assert.equal(manager.diagnosticSnapshot().manifestLoaded, false);
    const camera = new THREE.OrthographicCamera(-10, 10, 10, -10);
    camera.position.set(0, 100, 0);
    manager.update(camera, performance.now() + 6000, { mode: 'top' });
    await setImmediate();
    assert.equal(calls, 2);
    assert.equal(manager.diagnosticSnapshot().manifestLoaded, true);
  } finally {
    manager.dispose();
    globalThis.fetch = originalFetch;
  }
});

test('digest and archive scope switches abort pending tiles and dispose prior GPU residents', async (t) => {
  const { resourceClient } = await import('../src/resources/client.js');
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let generation = 0;
  let digest = 'c'.repeat(64);
  let scope = 'archive-A';
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.endsWith('/views/current'))
      return Response.json({
        schemaVersion: 1,
        viewId: String(generation + 1).repeat(64),
        mode: 'server',
        sourceScope: url.searchParams.get('world') === 'archive' ? scope : 'fixture',
        generation,
        renderRoot: 'b'.repeat(64),
      });
    return Response.json({
      hasTopMap: true,
      world: 'archive',
      dimension: 'minecraft:overworld',
      topMap: {
        regions: [
          {
            x: 0,
            z: 0,
            hash: digest,
            artifact: { digest, bytes: 1, mediaType: 'application/msgpack', format: 'topmap-msgpack-v6' },
          },
        ],
      },
    });
  };
  const manager = new TopMapManager(new THREE.Scene(), {} as never);
  t.after(() => manager.dispose());
  manager.configure('archive', 'minecraft:overworld', true);
  await setImmediate();
  // A resident fixture isolates replacement/disposal from GPU allocation and meshing.
  const state = manager as any;
  let disposed = 0;
  const resident = () => {
    const geometry = new THREE.BufferGeometry();
    const material = new THREE.ShaderMaterial();
    const texture = new THREE.Texture();
    for (const resource of [geometry, material, texture]) resource.addEventListener('dispose', () => disposed++);
    const mesh = new THREE.Mesh(geometry, material);
    state.group.add(mesh);
    state.tiles.set('0,0', { key: '0,0', mesh, material, data: { texture }, step: 1, coverageKey: '*', lastUsed: 0 });
    const abort = new AbortController();
    state.tileAborts.set('0,0', abort);
    state.pendingTiles.add('0,0');
    return abort;
  };
  const oldDownload = resident();
  digest = 'd'.repeat(64);
  generation++;
  await resourceClient.refresh();
  await setImmediate();
  assert.equal(oldDownload.signal.aborted, true);
  assert.equal(state.tiles.has('0,0'), false);
  assert.equal(disposed, 3);
  const priorArchive = resident();
  scope = 'archive-B';
  generation++;
  await resourceClient.refresh();
  await setImmediate();
  assert.equal(priorArchive.signal.aborted, true);
  assert.equal(state.tiles.has('0,0'), false);
  assert.equal(disposed, 6);
});

test('an obsolete tile failure cannot poison the replacement request or release its slot', async (t) => {
  const originalFetch = globalThis.fetch;
  const { resourceClient } = await import('../src/resources/client.js');
  const generation = resourceClient.current('archive')?.generation ?? 0;
  let fail!: (error: Error) => void;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/views/current'))
      return Response.json({
        schemaVersion: 1,
        viewId: '7'.repeat(64),
        mode: 'server',
        sourceScope: 'old-tile-error',
        generation,
        renderRoot: 'b'.repeat(64),
      });
    if (url.endsWith('/resolve'))
      return new Promise<Response>((_, reject) => {
        fail = reject;
      });
    return Response.json({
      hasTopMap: true,
      world: 'old-tile-error',
      dimension: 'minecraft:overworld',
      topMap: {
        regions: [
          {
            x: 0,
            z: 0,
            hash: 'c'.repeat(64),
            artifact: {
              digest: 'c'.repeat(64),
              bytes: 1,
              mediaType: 'application/msgpack',
              format: 'topmap-msgpack-v6',
            },
          },
        ],
      },
    });
  };
  const manager = new TopMapManager(new THREE.Scene(), {} as never);
  t.after(() => {
    manager.dispose();
    globalThis.fetch = originalFetch;
  });
  manager.configure('old-tile-error', 'minecraft:overworld', true);
  await setImmediate();
  assert.equal(manager.diagnosticSnapshot().manifestLoaded, true);
  const state = manager as any;
  let load!: Promise<void>;
  const loadTile = state.loadTile.bind(state);
  state.loadTile = (...args: unknown[]) => (load = loadTile(...args));
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10);
  camera.position.set(0, 100, 0);
  manager.update(camera, performance.now(), { mode: 'top' });
  assert.deepEqual(manager.diagnosticSnapshot().wantedTiles, ['0,0']);
  await setImmediate();
  assert.ok(fail, 'the original resolve must be in flight');
  const previous = state.tileAborts.get('0,0');
  previous.abort();
  const replacement = new AbortController();
  state.tileAborts.set('0,0', replacement);
  state.tileDigests.set('0,0', 'd'.repeat(64));
  fail(new Error('late transport error from an obsolete request'));
  await load;
  assert.equal(state.failedTiles.has('0,0'), false);
  assert.equal(state.tileAborts.get('0,0'), replacement);
  assert.equal(state.pendingTiles.has('0,0'), true);
});
