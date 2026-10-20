import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';
import { serve } from '@hono/node-server';
import { createApp } from '../../packages/server/dist/src/app.js';
import { S3Storage } from '../../packages/storage/dist/s3.js';
import { ensureWorldIdentity } from '../../packages/storage/dist/sync.js';
import { ScopedStorage } from '../../packages/storage/dist/prefixed.js';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { backupContent, restoreContent } from '../operations/content-snapshot.mjs';
import { execute, project, cleanEnv, boot } from './helpers/artifacts.mjs';
import { loadServerConfig } from '../../packages/server/dist/src/configuration.js';
import { createServices } from '../../packages/server/dist/src/services.js';
const checksum = (bytes) => createHash('sha256').update(bytes).digest('hex');
const reportDirectory = path.join(project, 'LOCAL_railway_deploy/phase7-acceptance');
async function configFile(root, name, worlds, content, blobs, extra = {}) {
  const file = path.join(root, `${name}.json`);
  const backends = {
    worlds: { driver: 'local', root: worlds },
    metadata: { driver: 'local', root: content },
    payloads: { driver: 'local', root: blobs },
    ...extra,
  };
  const storage = {
    backends,
    mounts: {
      worlds: { backend: 'worlds', prefix: '' },
      content: { backend: 'metadata', prefix: '' },
      blobs: { backend: 'payloads', prefix: '' },
    },
  };
  await fs.writeFile(
    file,
    JSON.stringify({
      deployment: { profile: 'sync' },
      auth: { mode: 'static', staticRole: 'admin' },
      features: { contentReads: true, contentWrites: true },
      storage,
    }),
  );
  return file;
}
const env = {
  STATIC_API_TOKEN: 'release-fixture-token',

  CORS_ORIGINS: 'https://viewer.example',
};
async function service(file) {
  const config = loadServerConfig({ configFile: file, env, cwd: project });
  return createServices(config, {
    database: () => {
      throw new Error('content must not initialize a user DB');
    },
  });
}
async function seed(services) {
  await services.worldStore.createWorld('village');
  const identity = await ensureWorldIdentity(new ScopedStorage(services.mounts.worlds, 'village'));
  const asset = await services.content.importMedia(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 8"><path fill="#ff00ff" d="M0 0h16v8H0z"/></svg>',
    ),
    'image/svg+xml',
    'fixture',
  );
  const layer = await services.content.createLayer({
    schemaVersion: 1,
    layerId: 'input',
    revision: 1,
    name: 'fixture',
    features: [
      {
        featureId: 'marker',
        kind: 'media',
        assetId: asset.document.assetId,
        versionId: asset.version.versionId,
        position: [0, 64, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        views: ['top', 'player'],
        placement: 'plane',
        size: [16, 8],
        anchor: [0.5, 0.5],
      },
    ],
  });
  const map = await services.content.createMap({ name: 'village', worldKey: 'village' });
  await services.content.setBinding(
    map.mapId,
    'main',
    { bindingId: 'main', dimension: 'overworld', layerId: layer.layerId, enabled: true, order: 0 },
    1,
  );
  await services.content.replaceLayer(layer.layerId, { ...layer, name: 'revision 2', revision: 2 }, 1);
  await services.mounts.blobs.replace('diagnostics/release.json', Buffer.from('{"source":"release-drill"}'));
  await services.mounts.blobs.replace('server-data/biomes.json', Buffer.from('{}'));
  return { map, layer, asset, identity };
}
async function digestMount(store) {
  const files = await store.list();
  return Promise.all(files.map(async (file) => ({ key: file.path, sha256: checksum(await store.read(file.path)) })));
}
async function report(name, data) {
  await fs.mkdir(reportDirectory, { recursive: true });
  await fs.writeFile(
    path.join(reportDirectory, name + '.json'),
    JSON.stringify({ ...data, verifiedAt: new Date().toISOString() }, null, 2),
  );
}

test('quiesced snapshot restores retained revisions/blobs and registrations across physical roots; rejects damage before writes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-release-restore-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worlds = path.join(root, 'worlds'),
    one = await configFile(root, 'one', worlds, path.join(root, 'one/content'), path.join(root, 'one/blobs'));
  const source = await service(one);
  const seeded = await seed(source);
  await source.close();
  const snapshot = path.join(root, 'snapshot');
  await assert.rejects(backupContent({ configFile: one, output: snapshot, env }), /quiesced/);
  const backed = JSON.parse(
    (
      await execute(
        process.execPath,
        [
          path.join(project, 'scripts/operations/content-snapshot.mjs'),
          'backup',
          '--config',
          one,
          '--output',
          snapshot,
          '--quiesced',
        ],
        { env: { ...cleanEnv, ...env } },
      )
    ).stdout,
  );
  const expected = { content: await digestMount(source.mounts.content), blobs: await digestMount(source.mounts.blobs) };
  const two = await configFile(
    root,
    'two',
    worlds,
    path.join(root, 'second/metadata'),
    path.join(root, 'third/payloads'),
  );
  const differentWorlds = path.join(root, 'different-worlds');
  await fs.mkdir(path.join(differentWorlds, 'village/.violet-map'), { recursive: true });
  await fs.writeFile(
    path.join(differentWorlds, 'village/.violet-map/identity.json'),
    JSON.stringify({ schema: 1, id: randomUUID(), createdAt: new Date().toISOString() }),
  );
  const mismatch = await configFile(
    root,
    'mismatch',
    differentWorlds,
    path.join(root, 'mismatch/content'),
    path.join(root, 'mismatch/blobs'),
  );
  await assert.rejects(
    restoreContent({ configFile: mismatch, input: snapshot, env, quiesced: true }),
    /world identity/,
  );
  const restored = JSON.parse(
    (
      await execute(
        process.execPath,
        [
          path.join(project, 'scripts/operations/content-snapshot.mjs'),
          'restore',
          '--config',
          two,
          '--input',
          snapshot,
          '--quiesced',
        ],
        { env: { ...cleanEnv, ...env } },
      )
    ).stdout,
  );
  assert.equal(restored.verified, true);
  const target = await service(two);
  t.after(() => target.close());
  assert.deepEqual(await digestMount(target.mounts.content), expected.content);
  assert.deepEqual(await digestMount(target.mounts.blobs), expected.blobs);
  assert.equal((await target.content.getLayer(seeded.layer.layerId, 1)).name, 'fixture');
  assert.equal((await target.content.snapshot(seeded.map.mapId, 'overworld')).sourceStatus, 'verified');
  assert.equal((await target.content.snapshot(seeded.map.mapId, 'overworld')).layers[0].document.revision, 2);
  await assert.rejects(restoreContent({ configFile: two, input: snapshot, env, quiesced: true }), /empty/);
  const broken = path.join(root, 'damaged');
  await fs.cp(snapshot, broken, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(broken, 'manifest.json'), 'utf8'));
  await fs.writeFile(path.join(broken, 'objects', manifest.entries[0].sha256), 'damaged');
  const empty = await configFile(
    root,
    'empty',
    worlds,
    path.join(root, 'empty/content'),
    path.join(root, 'empty/blobs'),
  );
  await assert.rejects(restoreContent({ configFile: empty, input: broken, env, quiesced: true }), /checksum/);
  assert.deepEqual(
    await fs.readdir(path.join(root, 'empty')).catch((e) => (e.code === 'ENOENT' ? [] : Promise.reject(e))),
    [],
  );
  const unsafe = path.join(root, 'unsafe');
  await fs.cp(snapshot, unsafe, { recursive: true });
  manifest.entries[0].key = '../outside';
  await fs.writeFile(path.join(unsafe, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(restoreContent({ configFile: empty, input: unsafe, env, quiesced: true }), /unsafe/);
  await target.worldStore.deleteWorld('village');
  assert.deepEqual(await digestMount(target.mounts.content), expected.content);
  assert.deepEqual(await digestMount(target.mounts.blobs), expected.blobs);
  assert.equal((await target.content.snapshot(seeded.map.mapId, 'overworld')).sourceStatus, 'missing');
  const deletedSnapshot = path.join(root, 'deleted-world-snapshot');
  await target.close();
  await backupContent({ configFile: two, output: deletedSnapshot, env, quiesced: true });
  const deletedTarget = await configFile(
    root,
    'deleted-target',
    worlds,
    path.join(root, 'deleted/content'),
    path.join(root, 'deleted/blobs'),
  );
  await restoreContent({ configFile: deletedTarget, input: deletedSnapshot, env, quiesced: true });
  const deletedService = await service(deletedTarget);
  try {
    assert.equal((await deletedService.content.snapshot(seeded.map.mapId, 'overworld')).sourceStatus, 'missing');
  } finally {
    await deletedService.close();
  }
  await report('snapshot-restore', {
    passed: true,
    backup: backed,
    restored,
    retainedRevisions: true,
    worldDeleteIsolated: true,
    damageRejectedBeforeWrites: true,
  });
});

test(
  'relocated current and pre-overlay artifacts exercise feature-off, old-config rollback and forward restore',
  { timeout: 240000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-release-rollback-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const oldRef = process.env.VIOLET_ROLLBACK_REF ?? '781bff4';
    const resolved = (await execute('git', ['rev-parse', `${oldRef}^{commit}`], { cwd: project })).stdout.trim();
    const archive = path.join(root, 'old.tar'),
      source = path.join(root, 'old-source');
    await fs.mkdir(source);
    const packed = await execute('git', ['archive', '--format=tar', resolved], {
      cwd: project,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 ** 2,
    });
    await fs.writeFile(archive, packed.stdout);
    await execute('tar', ['-xf', archive, '-C', source]);
    await execute('pnpm', ['install', '--frozen-lockfile'], { cwd: source, timeout: 120000, maxBuffer: 4 * 1024 ** 2 });
    await execute('pnpm', ['--filter', '@violet-map/server...', '--filter', '@violet-map/cli...', 'build'], {
      cwd: source,
      timeout: 120000,
      maxBuffer: 4 * 1024 ** 2,
    });
    const old = path.join(root, 'old-artifact'),
      current = path.join(root, 'current-artifact');
    for (const [cwd, target] of [
      [source, old],
      [project, current],
    ])
      await execute('pnpm', ['--filter', '@violet-map/server', 'deploy', '--legacy', '--prod', target], {
        cwd,
        timeout: 120000,
        maxBuffer: 4 * 1024 ** 2,
      });
    const worlds = path.join(root, 'data/worlds'),
      file = await configFile(root, 'current', worlds, path.join(root, 'content'), path.join(root, 'blobs'));
    const services = await service(file),
      seeded = await seed(services);
    await services.close();
    const contentDigest = await digestMount(services.mounts.content),
      blobDigest = await digestMount(services.mounts.blobs);
    const snapshot = path.join(root, 'snapshot');
    await backupContent({ configFile: file, output: snapshot, env, quiesced: true });
    const unrelated = path.join(root, 'unrelated-cwd');
    await fs.mkdir(unrelated);
    const currentEnv = {
      ...env,
      VIOLET_MAP_CONFIG: file,
      DATA_DIR: path.join(root, 'data'),
      CONTENT_READS_ENABLED: 'false',
      CONTENT_WRITES_ENABLED: 'false',
    };
    const disabled = await boot(current, currentEnv, unrelated);
    try {
      assert.equal((await (await fetch(disabled.url + '/api/capabilities')).json()).contentReads, false);
      assert.equal(
        (await fetch(disabled.url + `/api/maps/${seeded.map.mapId}/overlays?dimension=overworld`)).status,
        404,
      );
      assert.equal((await (await fetch(disabled.url + '/api/worlds')).json())[0].id, 'village');
      assert.ok(
        (await (await fetch(disabled.url + '/api/assets/bundle')).json()).models[
          'minecraft:violet_map/block_entity/chest'
        ],
      );
    } finally {
      await disabled.close();
    }
    const legacyConfig = path.join(root, 'legacy.json');
    await fs.writeFile(
      legacyConfig,
      JSON.stringify({
        deployment: { profile: 'sync' },
        auth: { mode: 'static', staticRole: 'admin' },
        storage: { driver: 'local' },
        worldsDir: worlds,
      }),
    );
    const legacyEnv = {
      ...env,
      VIOLET_MAP_CONFIG: legacyConfig,
      DATA_DIR: path.join(root, 'data'),
      WORLDS_DIR: worlds,
    };
    const oldServer = await boot(old, legacyEnv, unrelated);
    try {
      const caps = await (await fetch(oldServer.url + '/api/capabilities')).json();
      assert.equal(caps.contentReads, undefined);
      assert.equal((await (await fetch(oldServer.url + '/api/worlds')).json())[0].id, 'village');
      assert.equal(
        (await fetch(oldServer.url + `/api/maps/${seeded.map.mapId}/overlays?dimension=overworld`)).status,
        404,
      );
      assert.ok(Object.keys(await (await fetch(oldServer.url + '/api/data/biomes')).json()).length > 0);
    } finally {
      await oldServer.close();
    }
    assert.deepEqual(await digestMount(services.mounts.content), contentDigest);
    assert.deepEqual(await digestMount(services.mounts.blobs), blobDigest);
    const restoredConfig = await configFile(
      root,
      'restored',
      worlds,
      path.join(root, 'restored/content'),
      path.join(root, 'restored/blobs'),
    );
    await restoreContent({ configFile: restoredConfig, input: snapshot, env, quiesced: true });
    const forward = await boot(
      current,
      { ...env, VIOLET_MAP_CONFIG: restoredConfig, DATA_DIR: path.join(root, 'data') },
      unrelated,
    );
    try {
      const manifest = await (
        await fetch(
          forward.url +
            `/api/maps/${seeded.map.mapId}/overlays?dimension=overworld&viewId=${(await (await fetch(forward.url + '/api/resources/views/current')).json()).viewId}`,
        )
      ).json();
      assert.equal(manifest.sourceStatus, 'verified');
      assert.equal(manifest.layers[0].document.revision, 2);
      const oldCli = path.join(source, 'packages/cli/dist/cli.js'),
        archiveRoot = path.join(root, 'legacy-upload');
      await fs.cp(path.join(worlds, 'village'), archiveRoot, { recursive: true });
      await fs.writeFile(path.join(archiveRoot, 'legacy-client.txt'), 'original world protocol');
      await execute(
        process.execPath,
        [
          oldCli,
          '--cli-home',
          path.join(root, 'old-cli'),
          'world',
          'sync',
          '--from',
          archiveRoot,
          '--world',
          'village',
          '--target',
          'server',
        ],
        {
          cwd: unrelated,
          env: { ...cleanEnv, VIOLET_SERVER_URL: forward.url, VIOLET_SERVER_TOKEN: env.STATIC_API_TOKEN },
        },
      );
      assert.equal(
        await fs.readFile(path.join(worlds, 'village/legacy-client.txt'), 'utf8'),
        'original world protocol',
      );
      assert.deepEqual(await digestMount(services.mounts.content), contentDigest);
      assert.deepEqual(await digestMount(services.mounts.blobs), blobDigest);
    } finally {
      await forward.close();
    }
    await assert.rejects(fs.stat(path.join(root, 'data/users.pglite')), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(unrelated), []);
    await report('rollback', {
      passed: true,
      oldCommit: resolved,
      currentCommit: (await execute('git', ['rev-parse', 'HEAD'], { cwd: project })).stdout.trim(),
      featureOffWorldReads: true,
      pairedOldConfig: true,
      oldCliAgainstNewServer: true,
      externalContentUnchanged: true,
      forwardRestore: true,
      unrelatedWorkingDirectory: true,
      userDatabaseUntouched: true,
    });
  },
);

test(
  'real S3: named mounts, prefixed HTTP/CLI, Range/CORS, backend failure and cross-backend restore',
  { timeout: 180000, skip: !process.env.VIOLET_ACCEPTANCE_ENV_FILE },
  async (t) => {
    const secret = parseEnv(await fs.readFile(process.env.VIOLET_ACCEPTANCE_ENV_FILE, 'utf8')),
      environment = { ...env, S3_ACCESS_KEY: secret.S3_ACCESS_KEY, S3_SECRET_KEY: secret.S3_SECRET_KEY };
    const prefix = `violet-map/acceptance/${randomUUID()}`;
    const physical = new S3Storage({
      bucket: secret.S3_BUCKET_NAME,
      endpoint: secret.S3_API_ENDPOINT,
      region: secret.S3_REGION || 'auto',
      credentials: { accessKeyId: secret.S3_ACCESS_KEY, secretAccessKey: secret.S3_SECRET_KEY },
    });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-release-s3-'));
    let services, api;
    try {
      const definition = {
        driver: 's3',
        bucket: secret.S3_BUCKET_NAME,
        endpoint: secret.S3_API_ENDPOINT,
        region: secret.S3_REGION || 'auto',
        forcePathStyle: true,
        accessKeyIdEnv: 'S3_ACCESS_KEY',
        secretAccessKeyEnv: 'S3_SECRET_KEY',
      };
      const file = path.join(root, 's3.json');
      await fs.writeFile(
        file,
        JSON.stringify({
          deployment: { profile: 'sync' },
          auth: { mode: 'static', staticRole: 'admin' },
          features: { contentReads: true, contentWrites: true },
          storage: {
            backends: { remote: definition },
            mounts: Object.fromEntries(
              ['worlds', 'content', 'blobs'].map((name) => [name, { backend: 'remote', prefix: `${prefix}/${name}` }]),
            ),
          },
        }),
      );
      const config = loadServerConfig({ configFile: file, env: environment, cwd: root });
      services = await createServices(config, {
        database: () => {
          throw new Error('S3 content must not open a user DB');
        },
      });
      const seeded = await seed(services),
        app = createApp(config, services);
      api = serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: (request) => {
          const url = new URL(request.url);
          url.pathname = url.pathname.replace(/^\/violet(?=\/)/, '');
          return app.fetch(new Request(url, request));
        },
      });
      if (!api.listening) await new Promise((resolve) => api.once('listening', resolve));
      const base = `http://127.0.0.1:${api.address().port}/violet/`,
        request = (key, init) => fetch(new URL(key, base), init);
      const manifestResponse = await request(
        `api/maps/${seeded.map.mapId}/overlays?dimension=overworld&viewId=${(await (await request('api/resources/views/current')).json()).viewId}`,
      );
      assert.equal(manifestResponse.status, 200);
      const etag = manifestResponse.headers.get('etag'),
        manifest = await manifestResponse.json();
      assert.equal(
        (
          await request(
            `api/maps/${seeded.map.mapId}/overlays?dimension=overworld&viewId=${(await (await request('api/resources/views/current')).json()).viewId}`,
            {
              headers: { 'if-none-match': etag },
            },
          )
        ).status,
        304,
      );
      const resource = manifest.media[0].resource.url.slice(1),
        bytes = await request(resource);
      assert.equal(bytes.status, 200);
      const mediaEtag = bytes.headers.get('etag');
      assert.equal(checksum(Buffer.from(await bytes.arrayBuffer())), seeded.asset.version.digest);
      const partial = await request(resource, { headers: { range: 'bytes=0-3', origin: 'https://viewer.example' } });
      assert.equal(partial.status, 206);
      assert.equal(await partial.text(), '<svg');
      assert.equal(partial.headers.get('access-control-allow-origin'), 'https://viewer.example');
      assert.ok(partial.headers.get('access-control-expose-headers').includes('ETag'));
      assert.equal((await request(resource, { headers: { 'if-none-match': mediaEtag } })).status, 304);
      const preflight = await request(resource, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://viewer.example',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'range,if-none-match',
        },
      });
      assert.equal(preflight.status, 204);
      assert.match(preflight.headers.get('access-control-allow-headers'), /Range/);
      await execute(
        process.execPath,
        [
          path.join(project, 'packages/cli/dist/cli.js'),
          '--cli-home',
          path.join(root, 'cli'),
          'overlay',
          'layer',
          'export',
          seeded.layer.layerId,
        ],
        { cwd: root, env: { ...cleanEnv, VIOLET_SERVER_URL: base, VIOLET_SERVER_TOKEN: environment.STATIC_API_TOKEN } },
      );
      const key = `maps/${seeded.map.mapId}.json`,
        original = await services.mounts.content.read(key);
      await services.mounts.content.replace(key, Buffer.from('{broken'));
      const corrupt = await request(
        `api/maps/${seeded.map.mapId}/overlays?dimension=overworld&viewId=${(await (await request('api/resources/views/current')).json()).viewId}`,
      );
      assert.equal(corrupt.status, 500);
      assert.equal((await corrupt.json()).code, 'CORRUPT_CONTENT');
      assert.equal((await request('api/worlds')).status, 200);
      await services.mounts.content.replace(key, original);
      const read = services.mounts.content.read.bind(services.mounts.content);
      services.mounts.content.read = async () => {
        throw new Error('private-backend-error-marker');
      };
      try {
        const failure = await request(
          `api/maps/${seeded.map.mapId}/overlays?dimension=overworld&viewId=${(await (await request('api/resources/views/current')).json()).viewId}`,
        );
        assert.equal(failure.status, 503);
        assert.ok(!(await failure.text()).includes('private-backend-error-marker'));
        assert.equal((await request('api/worlds')).status, 200);
      } finally {
        services.mounts.content.read = read;
      }
      await new Promise((resolve) => {
        api.close(resolve);
        api.closeAllConnections();
      });
      api = undefined;
      await services.close();
      const snapshot = path.join(root, 'snapshot');
      const backup = await backupContent({ configFile: file, output: snapshot, env: environment, quiesced: true });
      const targetFile = path.join(root, 'mixed.json'),
        targetConfig = JSON.parse(await fs.readFile(file, 'utf8'));
      targetConfig.storage.backends.local = { driver: 'local', root: path.join(root, 'restored') };
      for (const name of ['content', 'blobs']) targetConfig.storage.mounts[name] = { backend: 'local', prefix: name };
      await fs.writeFile(targetFile, JSON.stringify(targetConfig));
      const restored = await restoreContent({
        configFile: targetFile,
        input: snapshot,
        env: environment,
        quiesced: true,
      });
      const mixed = await createServices(loadServerConfig({ configFile: targetFile, env: environment, cwd: root }));
      try {
        assert.equal((await mixed.content.snapshot(seeded.map.mapId, 'overworld')).sourceStatus, 'verified');
        assert.deepEqual(await digestMount(mixed.mounts.content), await digestMount(services.mounts.content));
        assert.deepEqual(await digestMount(mixed.mounts.blobs), await digestMount(services.mounts.blobs));
        await services.worldStore.deleteWorld('village');
        assert.ok((await services.mounts.content.list()).length > 0);
        assert.ok((await services.mounts.blobs.list()).length > 0);
      } finally {
        await mixed.close();
      }
      await report('s3', {
        passed: true,
        backend: 'existing R2 bucket / isolated random prefix',
        prefix,
        backupObjects: backup.objects,
        restored,
        range: true,
        etag: true,
        cors: true,
        cliWithApiPrefix: true,
        corruptionExplicit: true,
        backendErrorIsolated: true,
        worldDeleteIsolated: true,
        productionContentUntouched: true,
      });
    } finally {
      if (api)
        await new Promise((resolve) => {
          api.close(resolve);
          api.closeAllConnections();
        });
      await services?.close();
      await physical.deletePrefix(prefix);
      assert.equal((await physical.list(prefix)).length, 0);
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test('checked-in one-root, two-root and paired legacy examples normalize without touching storage', () => {
  const one = loadServerConfig({
    configFile: path.join(project, 'examples/overlays-one-root.yaml'),
    env,
    cwd: project,
  });
  const two = loadServerConfig({
    configFile: path.join(project, 'examples/overlays-two-roots.yaml'),
    env,
    cwd: project,
  });
  const legacy = loadServerConfig({
    configFile: path.join(project, 'examples/overlays-legacy.yaml'),
    env,
    cwd: project,
  });
  assert.equal(one.storage.mounts.worlds.backend, one.storage.mounts.content.backend);
  assert.notEqual(two.storage.mounts.worlds.backend, two.storage.mounts.content.backend);
  assert.equal(legacy.features.contentReads, false);
  assert.equal(legacy.storage.worldsDir, path.join(project, 'LOCAL_storage/worlds'));
});
