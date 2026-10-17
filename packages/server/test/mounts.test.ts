import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadServerConfig } from '../src/configuration.js';
import { createStorageMounts } from '../src/storage.js';
async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-mounts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'violet.yaml');
  return { root, file, write: (text: string) => fs.writeFile(file, text) };
}
const header = 'deployment:\n  profile: public\nfeatures:\n  contentReads: true\n';
test('one-root and mixed mounts isolate writes and lazily leave missing stores absent', async (t) => {
  const { root, file, write } = await fixture(t);
  await write(
    header +
      'storage:\n  backends:\n    main:\n      driver: local\n      root: physical\n  mounts:\n    worlds: { backend: main, prefix: worlds }\n    content: { backend: main, prefix: content }\n    blobs: { backend: main, prefix: blobs }\n',
  );
  const config = loadServerConfig({ env: {}, cwd: root, configFile: file });
  const mounts = await createStorageMounts(config);
  assert.equal(await mounts.content!.read('missing'), null);
  await assert.rejects(fs.stat(path.join(root, 'physical')), { code: 'ENOENT' });
  await mounts.content!.replace('maps/m.json', new Uint8Array([2]));
  await mounts.worlds.write('world/file', new Uint8Array([1]));
  await mounts.blobs!.write('blob', new Uint8Array([3]));
  await mounts.worlds.deletePrefix('world');
  assert.ok(await mounts.content!.read('maps/m.json'));
  assert.ok(await mounts.blobs!.read('blob'));
  const override = loadServerConfig({ env: { WORLDS_DIR: 'elsewhere' }, cwd: root, configFile: file });
  assert.equal(override.storage.worldsDir, path.join(root, 'elsewhere'));
  assert.equal(override.storage.mounts.content.backend, 'main');
  const overridden = await createStorageMounts(override);
  assert.ok(await overridden.content!.read('maps/m.json'));
  assert.equal(await overridden.worlds.read('world/file'), null);
  await write(
    header +
      'storage:\n  backends:\n    main: { driver: local, root: physical }\n    remote: { driver: s3, bucket: bucket, endpoint: "https://s3.example", accessKeyIdEnv: KEY, secretAccessKeyEnv: SECRET }\n  mounts:\n    worlds: { backend: main, prefix: worlds }\n    content: { backend: remote, prefix: metadata }\n    blobs: { backend: remote, prefix: blobs }\n',
  );
  const mixed = loadServerConfig({ env: { KEY: 'key', SECRET: 'secret' }, cwd: root, configFile: file });
  assert.equal(mixed.storage.backends.remote.driver, 's3');
  await write((await fs.readFile(file, 'utf8')).replace('contentReads: true', 'contentReads: false'));
  const disabled = await createStorageMounts(
    loadServerConfig({ env: { KEY: 'key', SECRET: 'secret' }, cwd: root, configFile: file }),
  );
  assert.equal(disabled.content, undefined);
});
test('overlap checks compare actual locations and segment prefixes, not names', async (t) => {
  const { root, file, write } = await fixture(t);
  for (const [a, b, reject] of [
    ['same', 'same', true],
    ['same', 'same/child', true],
    ['a', 'ab', false],
  ]) {
    await write(
      header +
        `storage:\n  backends:\n    one: { driver: local, root: physical }\n    two: { driver: local, root: ./physical }\n  mounts:\n    worlds: { backend: one, prefix: ${a} }\n    content: { backend: two, prefix: ${b} }\n    blobs: { backend: two, prefix: separate }\n`,
    );
    const load = () => loadServerConfig({ env: {}, cwd: root, configFile: file });
    if (reject) assert.throws(load, /overlapping/);
    else load();
  }
  await fs.mkdir(path.join(root, 'target'));
  await fs.symlink(path.join(root, 'target'), path.join(root, 'link'));
  await write(
    header +
      'storage:\n  backends:\n    one: { driver: local, root: target }\n    two: { driver: local, root: link }\n  mounts:\n    worlds: { backend: one, prefix: same }\n    content: { backend: two, prefix: same }\n',
  );
  assert.throws(() => loadServerConfig({ env: {}, cwd: root, configFile: file }), /overlapping/);
  await write(
    header +
      'storage:\n  backends:\n    one: { driver: s3, bucket: same, endpoint: "https://s3.example" }\n    two: { driver: s3, bucket: same, endpoint: "https://s3.example/" }\n  mounts:\n    worlds: { backend: one, prefix: a }\n    content: { backend: two, prefix: a/b }\n',
  );
  assert.throws(() => loadServerConfig({ env: {}, cwd: root, configFile: file }), /overlapping/);
});
test('legacy S3 prefix is applied once; named env targets mounts precisely and validates names', async (t) => {
  const { root, file, write } = await fixture(t);
  const config = loadServerConfig({
    env: { DEPLOYMENT_PROFILE: 'public', WORLD_STORAGE: 's3', S3_BUCKET: 'test', S3_PREFIX: 'old/path' },
    cwd: root,
  });
  assert.equal(config.storage.mounts.worlds.prefix, 'old/path');
  assert.equal('prefix' in config.storage.backends.legacy, false);
  const env = {
    DEPLOYMENT_PROFILE: 'public',
    CONTENT_READS_ENABLED: 'true',
    STORAGE_BACKEND_MAIN_DRIVER: 'local',
    STORAGE_BACKEND_MAIN_ROOT: 'physical',
    STORAGE_MOUNT_WORLDS_BACKEND: 'main',
    STORAGE_MOUNT_WORLDS_PREFIX: 'worlds',
    STORAGE_MOUNT_CONTENT_BACKEND: 'main',
    STORAGE_MOUNT_CONTENT_PREFIX: 'content',
    STORAGE_MOUNT_BLOBS_BACKEND: 'main',
    STORAGE_MOUNT_BLOBS_PREFIX: 'blobs',
  };
  assert.equal(loadServerConfig({ env, cwd: root }).storage.worldsDir, path.join(root, 'physical/worlds'));
  assert.throws(
    () => loadServerConfig({ env: { ...env, STORAGE_MOUNT_CONTENT_PRFIX: 'wrong' }, cwd: root }),
    /unknown/,
  );
  await write(header + 'storage:\n  backends:\n    main: { driver: local, root: physical, bucket: invalid }\n');
  assert.throws(() => loadServerConfig({ env: {}, cwd: root, configFile: file }), /local backend/);
});

test('same-priority legacy/named fields must agree, environment overrides YAML only on worlds', async (t) => {
  const { root, file, write } = await fixture(t);
  const yaml =
    header +
    'storage:\n  backends:\n    main: { driver: s3, endpoint: "https://s3.example", bucket: bucket, region: auto }\n  mounts:\n    worlds: { backend: main, prefix: worlds }\n    content: { backend: main, prefix: content }\n    blobs: { backend: main, prefix: blobs }\n';
  await write(yaml);
  const config = loadServerConfig({
    env: { S3_BUCKET: 'override', S3_PREFIX: 'changed' },
    cwd: root,
    configFile: file,
  });
  assert.equal(config.storage.s3.bucket, 'override');
  assert.equal(config.storage.s3.prefix, 'changed');
  assert.equal(config.storage.backends.main.driver === 's3' && config.storage.backends.main.bucket, 'bucket');
  assert.equal(config.storage.mounts.content.prefix, 'content');
  assert.throws(
    () =>
      loadServerConfig({
        env: { STORAGE_MOUNT_WORLDS_BACKEND: 'main', S3_BUCKET: 'conflict' },
        cwd: root,
        configFile: file,
      }),
    /conflicting.*S3_BUCKET/,
  );
  assert.equal(
    loadServerConfig({
      env: { STORAGE_MOUNT_WORLDS_BACKEND: 'main', WORLD_STORAGE: 's3', S3_BUCKET: 'bucket' },
      cwd: root,
      configFile: file,
    }).storage.s3.bucket,
    'bucket',
  );
  await write(yaml + 's3:\n  bucket: conflict\n');
  assert.throws(() => loadServerConfig({ env: {}, cwd: root, configFile: file }), /conflicting.*S3_BUCKET/);
});
