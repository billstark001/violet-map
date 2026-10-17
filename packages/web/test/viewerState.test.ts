import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeRuntime } from '../src/runtime.js';
import { loadWorlds, settings, worlds, worldsError, worldsLoading } from '../src/state/viewer.js';

test('world-list retries cancel superseded requests and never restore an obsolete selection', async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const pending: { signal: AbortSignal | null | undefined; resolve(response: Response): void }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('runtime-config.json')) return Response.json({});
    if (url.endsWith('api/capabilities'))
      return Response.json({
        protocolVersion: 1,
        adminApi: false,
        users: false,
        worldWrites: false,
        dataWrites: false,
        diagnostics: false,
        contentReads: false,
        contentWrites: false,
        authMode: 'none',
      });
    return new Promise<Response>((resolve) => {
      pending.push({ signal: init?.signal, resolve });
    });
  };
  await initializeRuntime({ origin: 'https://viewer.test' });
  const old = loadWorlds();
  const current = loadWorlds();
  assert.equal(pending[0].signal?.aborted, true);
  assert.equal(worldsLoading.value, true);
  pending[1].resolve(Response.json([{ id: 'latest', dimensions: ['minecraft:the_end'] }]));
  await current;
  pending[0].resolve(Response.json([{ id: 'obsolete', dimensions: ['minecraft:overworld'] }]));
  await old;
  assert.deepEqual(
    worlds.value.map((world) => world.id),
    ['latest'],
  );
  assert.equal(settings.state.value.world, 'latest');
  assert.equal(settings.state.value.dimension, 'minecraft:the_end');
  const failed = loadWorlds();
  pending[2].resolve(new Response('offline', { status: 503 }));
  await failed;
  assert.match(worldsError.value ?? '', /503/);
  assert.equal(worldsLoading.value, false);
  const retry = loadWorlds();
  pending[3].resolve(Response.json([]));
  await retry;
  assert.equal(worldsError.value, null);
  assert.equal(settings.state.value.world, '');
});
