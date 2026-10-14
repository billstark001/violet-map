import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { encode } from '@msgpack/msgpack';
import { createApp } from '../src/app.js';
import { createServices } from '../src/services.js';
import { createAuthorization } from '../src/auth.js';
import { loadServerConfig } from '../src/configuration.js';
import type { UserService } from '../src/users.js';

test('all feature combinations remove disabled routes even with root authorization', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-features-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (let mask = 0; mask < 32; mask++) {
    const [adminApi, users, worldWrites, dataWrites, diagnostics] = [0, 1, 2, 3, 4].map((bit) => !!(mask & (1 << bit)));
    const config = loadServerConfig({
      env: {
        DEPLOYMENT_PROFILE: 'public',
        ADMIN_API_ENABLED: String(adminApi),
        USERS_ENABLED: String(users),
        WORLD_WRITES_ENABLED: String(worldWrites),
        DATA_WRITES_ENABLED: String(dataWrites),
        DIAGNOSTICS_ENABLED: String(diagnostics),
        AUTH_MODE: users ? 'users' : 'static',
        STATIC_API_TOKEN: 'secret',
        DATA_DIR: path.join(root, String(mask)),
        WORLDS_DIR: path.join(root, String(mask), 'worlds'),
      },
      cwd: root,
    });
    const baseConfig = loadServerConfig({
      env: { DEPLOYMENT_PROFILE: 'public', DATA_DIR: config.data.dir, WORLDS_DIR: config.storage.worldsDir },
      cwd: root,
    });
    const services = await createServices(baseConfig, {
      database: () => {
        throw new Error('database touched');
      },
    });
    services.authorization = createAuthorization({
      authenticateCredential: async () => ({ id: 'root', username: 'operator', role: 'root', source: 'root' }),
    });
    services.users = {
      listUsers: async () => [],
      authenticateCredential: async () => ({ id: 'root', username: 'operator', role: 'root', source: 'root' }),
    } as unknown as UserService;
    const app = createApp(config, services);
    const request = (url: string, method = 'GET', body?: string | Uint8Array) =>
      app.request(url, {
        method,
        headers: { authorization: 'Bearer root', 'content-type': 'application/json' },
        ...(body ? { body: body as BodyInit } : {}),
      });
    assert.equal((await request('/api/admin/storage/list')).status, adminApi ? 200 : 404, `${mask}: storage read`);
    assert.equal((await request('/api/admin/worlds/world/diff', 'POST', '{"files":[]}')).status, adminApi ? 200 : 404);
    assert.equal(
      (await request('/api/admin/storage/files/world/file', 'PUT', 'test')).status,
      adminApi && worldWrites ? 200 : 404,
    );
    assert.equal(
      (await request('/api/admin/worlds', 'POST', '{"world":"world"}')).status,
      adminApi && worldWrites ? 200 : 404,
    );
    assert.equal((await request('/api/assets/reload', 'POST')).status, adminApi && dataWrites ? 200 : 404);
    assert.equal((await request('/api/data/biomes', 'PUT', '{}')).status, adminApi && dataWrites ? 200 : 404);
    assert.equal((await request('/api/admin/users')).status, adminApi && users ? 200 : 404);
    assert.equal((await request('/api/auth/me')).status, users ? 200 : 404);
    assert.equal((await request('/api/auth/login', 'POST', '{}')).status, users ? 400 : 404);
    assert.equal((await request('/api/diagnostics', 'POST', '{}')).status, diagnostics ? 200 : 404);
    const capabilities = await (await request('/api/capabilities')).json();
    assert.equal(capabilities.worldWrites, adminApi && worldWrites);
    assert.equal(capabilities.dataWrites, adminApi && dataWrites);
    await services.close();
    await services.close();
  }
});

test('public and sync never open a user DB; public POST reads and static authorization work', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-public-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const profile of ['public', 'sync']) {
    const config = loadServerConfig({
      env: {
        DEPLOYMENT_PROFILE: profile,
        STATIC_API_TOKEN: 'test-secret',
        DATA_DIR: path.join(root, profile),
        WORLDS_DIR: path.join(root, profile, 'worlds'),
      },
      cwd: root,
    });
    const services = await createServices(config, {
      database: () => {
        throw new Error('must not open DB');
      },
    });
    const app = createApp(config, services);
    assert.equal((await app.request('/api/worlds')).status, 200);
    for (const url of ['chunks', 'chunk-hashes'])
      assert.equal(
        (
          await app.request(`/api/worlds/world/minecraft:overworld/${url}`, {
            method: 'POST',
            body: encode({ chunks: [] }) as BodyInit,
          })
        ).status,
        200,
      );
    assert.equal((await app.request('/api/auth/me')).status, 404);
    assert.equal((await app.request('/api/admin/storage/list')).status, profile === 'public' ? 404 : 401);
    assert.equal(
      (await app.request('/api/admin/storage/list', { headers: { authorization: 'Bearer wrong' } })).status,
      profile === 'public' ? 404 : 401,
    );
    if (profile === 'sync') {
      assert.equal(
        (await app.request('/api/admin/storage/list', { headers: { authorization: 'Bearer test-secret' } })).status,
        200,
      );
      assert.equal(
        (
          await app.request('/api/data/biomes', {
            method: 'PUT',
            body: '{}',
            headers: { authorization: 'Bearer test-secret' },
          })
        ).status,
        404,
      );
      const viewerConfig = loadServerConfig({
        env: { DEPLOYMENT_PROFILE: 'sync', STATIC_API_TOKEN: 'test-secret', STATIC_TOKEN_ROLE: 'viewer' },
        cwd: root,
      });
      const viewer = await createServices(viewerConfig);
      assert.equal(
        (
          await createApp(viewerConfig, viewer).request('/api/admin/storage/list', {
            headers: { authorization: 'Bearer test-secret' },
          })
        ).status,
        403,
      );
      await viewer.close();
    }
    await assert.rejects(fs.stat(config.database.dir), { code: 'ENOENT' });
    await services.close();
  }
});
