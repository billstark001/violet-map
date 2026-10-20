import { PublicationStore } from '@violet-map/resources';
import { LocalStorage } from '@violet-map/storage/local';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadServerConfig } from '../src/configuration.js';
import { createServices } from '../src/services.js';

const nbt = new Uint8Array([
  10, 0, 0, 3, 0, 4, 120, 80, 111, 115, 0, 0, 0, 0, 3, 0, 4, 122, 80, 111, 115, 0, 0, 0, 0, 0,
]);

function denyWrites() {
  let writes = 0;
  const restore: (() => void)[] = [];
  for (const name of [
    'writeFile',
    'appendFile',
    'mkdir',
    'rename',
    'link',
    'unlink',
    'rm',
    'rmdir',
    'truncate',
    'copyFile',
    'chmod',
    'chown',
    'mkdtemp',
  ] as const) {
    const old = fs[name];
    (fs as any)[name] = async () => {
      writes++;
      throw new Error(`unexpected fs write: ${name}`);
    };
    restore.push(() => {
      (fs as any)[name] = old;
    });
  }
  const open = fs.open;
  fs.open = async (...args: Parameters<typeof open>) => {
    if (typeof args[1] !== 'string' || /[wa+]/.test(args[1])) {
      writes++;
      throw new Error('unexpected writable open');
    }
    return open(...args);
  };
  restore.push(() => {
    fs.open = open;
  });
  return {
    get writes() {
      return writes;
    },
    restore() {
      for (const fn of restore) fn();
    },
  };
}

test('E01/E05/E09 public reader has no source services, writer, filesystem writes or SQLite initialization', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-reader-role-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const authority = new LocalStorage(path.join(root, 'authority'));
  const publisher = new PublicationStore(authority, authority);
  const head = await publisher.commit(
    {
      schemaVersion: 1,
      sourceScope: 'fixture',
      archiveIds: {},
      sourceScopes: {},
      renderRoot: 'a'.repeat(64),
      worlds: [],
      entries: [],
      regions: [],
      coverage: {},
      topMaps: {},
      overlays: [],
    },
    null,
    async () => {},
    async () => {},
  );
  await publisher.close();
  const file = path.join(root, 'reader.yaml');
  await fs.writeFile(
    file,
    `deployment:\n  profile: public\nstorage:\n  backends:\n    state:\n      driver: local\n      root: ${root}\nresources:\n  cache:\n    memoryBytes: 0\n  delivery:\n    mode: public\n    publicBaseUrl: https://resources.example/\n    targetMount: { backend: state, prefix: objects }\n  publication:\n    storeMount: { backend: state, prefix: authority }\n`,
  );
  const config = loadServerConfig({ env: {}, cwd: root, configFile: file });
  const guard = denyWrites();
  const imports = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'node:sqlite' || /\/src\/(assetPack|worldChunks|worldStore|gameData)\./.test(specifier))
        throw new Error(`disabled driver initialized: ${specifier}`);
      return next(specifier, context);
    },
  });
  try {
    const services = await createServices(config);
    try {
      assert.equal(services.assets, undefined);
      assert.equal(services.worldStore, undefined);
      assert.equal(services.mounts.worlds, undefined);
      assert.equal(services.resources.repository, undefined);
      const app = createApp(config, services);
      assert.equal((await (await app.request('/api/resources/views/current')).json()).viewId, head.publicationId);
      assert.deepEqual(await (await app.request('/api/worlds')).json(), []);
      assert.equal((await app.request('/api/admin/resources/publications', { method: 'POST' })).status, 404);
      await services.resources.status();
      assert.equal(guard.writes, 0);
    } finally {
      await services.close();
    }
  } finally {
    imports.deregister();
    guard.restore();
  }
});

test('E02/E03 zero retention dynamic service completes generation and shutdown without local writes or SQLite', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-dynamic-role-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await new LocalStorage(path.join(root, 'worlds')).write('world/chunks/minecraft%3Aoverworld/c.0.0.nbt', nbt);
  const config = loadServerConfig({
    env: {
      DEPLOYMENT_PROFILE: 'public',
      DATA_DIR: root,
      WORLDS_DIR: path.join(root, 'worlds'),
      RESOURCES_CACHE_MEMORY_BYTES: '0',
    },
    cwd: root,
  });
  const guard = denyWrites();
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'node:sqlite') throw new Error('unexpected SQLite load');
      return next(specifier, context);
    },
  });
  try {
    let oldView = '';
    for (let restart = 0; restart < 2; restart++) {
      const services = await createServices(config);
      try {
        const head = await services.resources.head('world');
        assert.notEqual(head.viewId, oldView);
        oldView = head.viewId;
        const batch = await services.resources.resolve(head.viewId, [
          { kind: 'chunk', world: 'world', dimension: 'minecraft:overworld', cx: 0, cz: 0 },
        ]);
        assert.ok('resource' in batch.resources[0]);
        const item = batch.resources[0];
        if (!('resource' in item)) throw new Error('missing');
        const body = await services.resources.open(head.viewId, 'chunk', item.resource.artifact.digest);
        const lease = await body.read();
        lease.release();
        assert.equal(services.resources.repository!.cache.bytes, 0);
        assert.equal(guard.writes, 0);
      } finally {
        await services.close();
      }
    }
  } finally {
    hook.deregister();
    guard.restore();
  }
});

test('E07/E08 explicit local/workspace failures do not switch drivers and release an acquired cache owner', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-selected-drivers-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cache = path.join(root, 'cache');
  const badIndex = path.join(root, 'invalid.sqlite');
  await fs.writeFile(badIndex, 'corrupt selected SQLite file');
  const file = path.join(root, 'config.json');
  const settings = {
    deployment: { profile: 'public' },
    resources: {
      cache: {
        memoryBytes: 0,
        local: { directory: cache, bytes: 4096, storageClass: 'persistent' },
        index: { driver: 'sqlite', path: badIndex },
      },
      work: { workspace: { directory: path.join(root, 'temporary'), maxBytes: 4096, storageClass: 'temporary' } },
    },
  };
  await fs.writeFile(file, JSON.stringify(settings));
  await assert.rejects(createServices(loadServerConfig({ configFile: file, env: {}, cwd: root })), /not a database/);
  const owner = JSON.parse(await fs.readFile(path.join(cache, 'cache-owner.json'), 'utf8'));
  assert.equal(owner.owner, null);
  settings.resources.cache.index = { driver: 'memory' } as never;
  await fs.writeFile(file, JSON.stringify(settings));
  const service = await createServices(loadServerConfig({ configFile: file, env: {}, cwd: root }));
  await service.resources.head();
  await service.close();
  await fs.rm(path.join(root, 'temporary'), { recursive: true });
  const restarted = await createServices(loadServerConfig({ configFile: file, env: {}, cwd: root }));
  await restarted.resources.head();
  await restarted.close();
  await fs.writeFile(path.join(root, 'not-a-directory'), 'blocked');
  settings.resources.work.workspace.directory = path.join(root, 'not-a-directory', 'child');
  await fs.writeFile(file, JSON.stringify(settings));
  await assert.rejects(async () => createServices(loadServerConfig({ configFile: file, env: {}, cwd: root })));
  assert.equal(JSON.parse(await fs.readFile(path.join(cache, 'cache-owner.json'), 'utf8')).owner, null);
});

test('public content-only reads do not initialize derived caches, workspace or SQLite', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-content-reader-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'reader.json');
  const settings = {
    deployment: { profile: 'public' },
    features: { contentReads: true },
    data: { dir: root },
    resources: {
      cache: {
        local: { directory: path.join(root, 'content/blobs'), bytes: 4096, storageClass: 'persistent' },
        index: { driver: 'sqlite', path: path.join(root, 'unselected.sqlite') },
      },
      work: { workspace: { directory: path.join(root, 'workspace'), maxBytes: 4096, storageClass: 'temporary' } },
      delivery: {
        mode: 'public',
        targetMount: { backend: 'auxiliary', prefix: 'public' },
        publicBaseUrl: 'https://resources.example/',
      },
      publication: { storeMount: { backend: 'auxiliary', prefix: 'control' } },
    },
  };
  await fs.writeFile(file, JSON.stringify(settings));
  const config = loadServerConfig({ env: {}, configFile: file, cwd: root });
  const guard = denyWrites();
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'node:sqlite') throw new Error('unexpected SQLite load');
      return next(specifier, context);
    },
  });
  try {
    const services = await createServices(config);
    try {
      assert.ok(services.content);
      assert.equal(services.assets, undefined);
      assert.deepEqual(await services.content.listMaps(), []);
      assert.equal(services.resources.repository!.handoff.budget.bytes, 0);
    } finally {
      await services.close();
    }
    assert.equal(guard.writes, 0);
  } finally {
    hook.deregister();
    guard.restore();
  }
  // Enabling dynamic world reads activates the selected cache and its overlap checks.
  settings.features = { contentReads: true, worldReads: true } as typeof settings.features;
  await fs.writeFile(file, JSON.stringify(settings));
  assert.throws(() => loadServerConfig({ env: {}, configFile: file, cwd: root }), /overlapping storage mounts/);
});
