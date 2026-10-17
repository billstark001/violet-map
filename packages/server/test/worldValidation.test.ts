import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ObjectStorage } from '@violet-map/core/storage';
import { createWorldStore } from '../src/worldStore.js';
import { createTopMapService } from '../src/topMap.js';
import { loadServerConfig } from '../src/configuration.js';
import { createServices } from '../src/services.js';
import { createApp } from '../src/app.js';

test('invalid world names and create inputs fail before any backend access', async () => {
  let calls = 0;
  const blocked = async (): Promise<never> => {
    calls++;
    throw new Error('backend must not be touched');
  };
  const storage: ObjectStorage = {
    kind: 'local',
    read: blocked,
    readRange: blocked,
    stat: blocked,
    list: blocked,
    listDirectories: blocked,
    write: blocked,
    delete: blocked,
    deletePrefix: blocked,
  };
  const config = loadServerConfig({ env: { DEPLOYMENT_PROFILE: 'public' }, cwd: '/tmp' });
  const top = createTopMapService(storage, config);
  const world = createWorldStore(storage, top, config);
  for (const name of ['.', '..', 'a/b', '']) {
    for (const operation of [
      () => world.deleteWorld(name),
      () => world.createWorld(name),
      () => world.worldManifest(name),
      () => world.saveWorldFile(name, 'file', new Uint8Array()),
      () => world.getChunkMetadata(name, 'overworld', 0, 0),
      () => top.getTopMapManifest(name),
    ])
      await assert.rejects(operation(), /invalid world name/);
  }
  await assert.rejects(world.ensureLevelDat('valid', 'name', ['../invalid']), /invalid dimension/);
  await assert.rejects(world.ensureLevelDat('valid', 'name', 'bad' as unknown as string[]), /invalid dimensions/);
  await assert.rejects(world.ensureLevelDat('valid', 3 as unknown as string), /invalid level name/);
  assert.equal(calls, 0);
});

test('world HTTP mutations reject malformed input without partial worlds and preserve encoded names', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-world-validation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = loadServerConfig({
    env: {
      DEPLOYMENT_PROFILE: 'sync',
      STATIC_API_TOKEN: 'test',
      DATA_DIR: root,
      WORLDS_DIR: path.join(root, 'worlds'),
    },
    cwd: root,
  });
  const services = await createServices(config);
  t.after(() => services.close());
  const app = createApp(config, services);
  const headers = { authorization: 'Bearer test', 'content-type': 'application/json' };
  for (const body of [
    { world: '.' },
    { world: '..' },
    { world: 1 },
    { world: 'partial', dimensions: ['../bad'] },
    { world: 'partial', levelName: {} },
    null,
    [],
  ])
    assert.equal(
      (await app.request('/api/admin/worlds', { method: 'POST', headers, body: JSON.stringify(body) })).status,
      400,
    );
  assert.deepEqual(await services.mounts.worlds.list(), []);
  assert.equal(
    (await app.request('/api/admin/worlds/partial/create', { method: 'POST', headers, body: '{' })).status,
    400,
  );
  assert.deepEqual(await services.mounts.worlds.list(), []);
  assert.equal((await app.request('/api/admin/worlds/a%2Fb', { method: 'DELETE', headers })).status, 400);
  assert.equal((await app.request('/api/worlds/a%2Fb/capabilities')).status, 400);
  const uploaded = await app.request('/api/admin/worlds/%66oo/files/test.bin', {
    method: 'PUT',
    headers,
    body: new Uint8Array([42]),
  });
  assert.equal(uploaded.status, 200);
  assert.deepEqual(await services.mounts.worlds.read('foo/test.bin'), new Uint8Array([42]));
});
