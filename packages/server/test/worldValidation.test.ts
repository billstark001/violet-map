import type { ObjectStorage } from '@violet-map/core/storage';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadServerConfig } from '../src/configuration.js';
import { createServices } from '../src/services.js';
import { createTopMapService } from '../src/topMap.js';
import { createWorldStore } from '../src/worldStore.js';

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
  const world = createWorldStore(storage, config.minecraft.version);
  for (const name of ['.', '..', 'a/b', '']) {
    for (const operation of [
      () => world.deleteWorld(name),
      () => world.createWorld(name),
      () => world.worldManifest(name),
      () => world.saveWorldFile(name, 'file', new Uint8Array()),
      () => world.inspectChunks(name, 'overworld', [{ cx: 0, cz: 0 }]).then((rows) => rows[0] ?? null),
      () => world.deleteChunks(name, 'overworld', []),
      () => top.getTopMapManifest(name),
    ])
      await assert.rejects(operation(), /invalid world name/);
  }
  await assert.rejects(world.ensureLevelDat('valid', 'name', ['../invalid']), /invalid dimension/);
  await assert.rejects(world.ensureLevelDat('valid', 'name', 'bad' as unknown as string[]), /invalid dimensions/);
  await assert.rejects(world.ensureLevelDat('valid', 3 as unknown as string), /invalid level name/);
  await assert.rejects(world.deleteChunks('valid', 'overworld', [{ cx: 0, cz: 0 }, null as never]), /invalid chunk/);
  await assert.rejects(world.deleteChunks('valid', '..:bad', []), /invalid dimension/);
  await assert.rejects(world.diffWorldManifest('valid', [{ path: '../bad' }]), /invalid world manifest/);
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
  config.limits.uploadBytes = 256;
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
  for (const body of [{ chunks: [{ cx: 0, cz: 0 }, null] }, { chunks: [{ cx: 0x80000000, cz: 0 }] }, null])
    assert.equal(
      (
        await app.request('/api/admin/worlds/foo/minecraft:overworld/chunks', {
          method: 'DELETE',
          headers,
          body: JSON.stringify(body),
        })
      ).status,
      400,
    );
  for (const body of [
    null,
    [],
    { files: [null] },
    { files: [{ path: 1 }] },
    { files: [{ path: '../bad' }] },
    { files: [{ path: 'ok', size: -1 }] },
  ])
    assert.equal(
      (await app.request('/api/admin/worlds/foo/diff', { method: 'POST', headers, body: JSON.stringify(body) })).status,
      400,
    );
  assert.equal((await app.request('/api/admin/worlds/foo/diff', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal(
    (await app.request('/api/admin/worlds/foo/diff', { method: 'POST', headers, body: ' '.repeat(257) })).status,
    413,
  );
  assert.equal((await app.request('/api/admin/worlds/foo/diff', { method: 'POST', headers, body: '{}' })).status, 200);
  const uploaded = await app.request('/api/admin/worlds/%66oo/files/test.bin', {
    method: 'PUT',
    headers,
    body: new Uint8Array([42]),
  });
  assert.equal(uploaded.status, 200);
  assert.deepEqual(await services.mounts.worlds.read('foo/test.bin'), new Uint8Array([42]));
  for (const name of ['Ancient City Restoration', 'Surv#Vanilla', '世界', 'a%20b']) {
    const created = await app.request('/api/admin/worlds', {
      method: 'POST',
      headers,
      body: JSON.stringify({ world: name }),
    });
    assert.equal(created.status, 200);
    assert.ok((await services.worldStore!.listWorlds()).some((world) => world.id === name));
    const uploaded = await app.request(`/api/admin/worlds/${encodeURIComponent(name)}/files/test.bin`, {
      method: 'PUT',
      headers,
      body: new Uint8Array([7]),
    });
    assert.equal(uploaded.status, 200);
    assert.deepEqual(await services.mounts.worlds.read(`${name}/test.bin`), new Uint8Array([7]));
    assert.equal((await app.request(`/api/worlds/${encodeURIComponent(name)}/capabilities`)).status, 200);
  }
});

test('world discovery skips malformed encoded directories and metadata while retaining valid nested dimensions', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-discovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = loadServerConfig({
    env: { DEPLOYMENT_PROFILE: 'public', DATA_DIR: root, WORLDS_DIR: path.join(root, 'worlds') },
    cwd: root,
  });
  const services = await createServices(config);
  t.after(() => services.close());
  const storage = services.mounts.worlds;
  for (const file of [
    'valid/dimensions/custom/region/inner/region/r.0.0.mca',
    'valid/dimensions/%E0%A4%A/other/region/r.0.0.mca',
    'valid/chunks/%E0%A4%A/c.0.0.nbt',
    'valid/chunks/custom%3Aother/c.0.0.nbt',
    'valid/chunks/..%3Abad/c.0.0.nbt',
    'valid/chunks/custom%3Aother/c.999999999999999999.0.nbt',
    'invalid/region/r.99999999999999999999999.0.mca',
    'valid/dimensions/custom/region/inner/region/r.67108864.0.mca',
  ])
    await storage.write(file, new Uint8Array(8192));
  await storage.write(
    'valid/.violet-map/world.json',
    new TextEncoder().encode(JSON.stringify({ dimensions: ['..:bad', 'custom:valid'] })),
  );
  assert.deepEqual(await services.worldStore.listRegions('valid', 'custom:region/inner'), [{ x: 0, z: 0 }]);
  assert.deepEqual(await services.worldStore.listChunkSourceCoverage('valid', 'custom:other'), {
    regions: [],
    chunks: [{ cx: 0, cz: 0 }],
  });
  assert.deepEqual(await services.worldStore.listWorlds(), [
    { id: 'valid', dimensions: ['custom:other', 'custom:region/inner', 'custom:valid'] },
  ]);
});
