import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadServerConfig, readAdminConfig } from '../src/configuration.js';

test('configuration validates values, names, secrets, and authentication combinations', () => {
  const load = (env: NodeJS.ProcessEnv) => loadServerConfig({ env, cwd: '/tmp' });
  assert.equal(load({}).deployment.profile, 'full');
  assert.equal(load({ DEPLOYMENT_PROFILE: 'public' }).features.adminApi, false);
  assert.equal(load({ DEPLOYMENT_PROFILE: 'sync', STATIC_API_TOKEN: 'test' }).auth.mode, 'static');
  for (const value of ['', 'no', '2']) assert.throws(() => load({ USERS_ENABLED: value }), /boolean/);
  for (const value of ['', 'bad', '0', '65536', '1.2']) assert.throws(() => load({ PORT: value }), /integer/);
  assert.equal(load({ REGION_CACHE_BYTES: '0' }).cache.regionBytes, 0);
  assert.equal(load({}).limits.mediaImports, 1);
  assert.equal(load({ MEDIA_IMPORT_QUEUE: '0' }).limits.mediaQueue, 0);
  assert.throws(() => load({ MEDIA_IMPORT_CONCURRENCY: '0' }), /MEDIA_IMPORT_CONCURRENCY/);
  assert.throws(() => load({ MEDIA_IMPORT_QUEUE: '-1' }), /MEDIA_IMPORT_QUEUE/);
  assert.equal(load({}).limits.contentMutations, 1);
  assert.equal(load({}).limits.contentQueue, 32);
  assert.equal(load({ CONTENT_MUTATION_QUEUE: '0' }).limits.contentQueue, 0);
  assert.throws(() => load({ CONTENT_MUTATION_CONCURRENCY: '0' }), /CONTENT_MUTATION_CONCURRENCY/);
  assert.throws(() => load({ CONTENT_MUTATION_QUEUE: '-1' }), /CONTENT_MUTATION_QUEUE/);
  assert.throws(() => load({ DEPLOYMENT_PROFILE: 'sync' }), /STATIC_API_TOKEN/);
  assert.throws(() => load({ USERS_ENABLED: 'false' }), /require authentication/);
  assert.throws(() => load({ AUTH_MODE: 'static', STATIC_API_TOKEN: 'secret' }), /conflicts/);
  assert.equal(load({ ADMIN_API_ENABLED: 'false' }).features.worldWrites, false);
  assert.throws(() => load({ DEPLOYMENT_PROFILE: 'toString' }), /public, sync, or full/);
  assert.throws(() => load({ MEDIA_PUBLIC_BASE_URL: 'https://media.example/blobs' }), /removed/);
  for (const value of [
    'file:///tmp/blobs',
    '//media.example',
    'https://user:password@media.example',
    'https://media.example/?token=1',
  ])
    assert.throws(() => load({ MEDIA_PUBLIC_BASE_URL: value }));
});

test('YAML paths use the file directory, environment paths use cwd, aliases must agree', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'settings');
  await fs.mkdir(dir);
  const file = path.join(dir, 'violet.yaml');
  const write = (text: string) => fs.writeFile(file, text);
  await write('deployment:\n  profile: public\nserver:\n  port: 3400\nassets:\n  dirs: [packs]\ndata:\n  dir: files\n');
  const config = loadServerConfig({ env: { PORT: '3500', WORLDS_DIR: 'worlds' }, cwd: root, configFile: file });
  assert.equal(config.server.port, 3500);
  assert.equal(config.assets.dirs[0], path.join(dir, 'packs'));
  assert.equal(config.data.dir, path.join(dir, 'files'));
  assert.equal(config.storage.worldsDir, path.join(root, 'worlds'));
  await write('port: 3400\nserver:\n  port: 3401\n');
  assert.throws(() => loadServerConfig({ env: { PORT: '3500' }, configFile: file }), /conflicting/);
  await write('features:\n  admnApi: false\n');
  assert.throws(() => loadServerConfig({ env: {}, configFile: file }), /features.admnApi/);
  await write('auth:\n  staticToken: super-secret\n');
  assert.throws(
    () => loadServerConfig({ env: {}, configFile: file }),
    (error) => !String(error).includes('super-secret'),
  );
  await write('deployment:\n  profile: sync\ns3:\n  bucket: ""\ndatabase:\n  dir: users\n');
  assert.equal(readAdminConfig({ env: {}, cwd: root, configFile: file }).databaseDir, path.join(dir, 'users'));
  await write('data:\n  dir: files\ndatabase:\n  dir: users\n');
  assert.equal(readAdminConfig({ env: {}, cwd: root, configFile: file }).databaseDir, path.join(dir, 'users'));
  await write('server:\n  port: false\n');
  assert.throws(() => loadServerConfig({ env: { PORT: '3500' }, configFile: file }), /server.port/);
  await write('auth: [secret-value\n');
  assert.throws(
    () => loadServerConfig({ env: {}, configFile: file }),
    (error) => {
      assert.doesNotMatch(String(error), /secret-value/);
      assert.equal((error as Error).cause, undefined);
      return true;
    },
  );
  assert.throws(() => loadServerConfig({ env: {}, cwd: root, configFile: 'missing.yaml' }), /failed to load/);
});
