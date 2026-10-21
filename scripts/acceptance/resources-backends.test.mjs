import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { S3Storage } from '../../packages/storage/dist/s3.js';
import { ContentAddressedStorage, artifactRef } from '../../packages/storage/dist/contentAddressed.js';
import { loadServerConfig } from '../../packages/server/dist/src/configuration.js';
import { createServices } from '../../packages/server/dist/src/services.js';
const execute = promisify(execFile);
const docker = async (...args) =>
  (await execute('docker', args, { timeout: 240000, maxBuffer: 4 * 1024 ** 2 })).stdout.trim();
const require = createRequire(new URL('../../packages/storage/package.json', import.meta.url));
const { S3Client, CreateBucketCommand, PutBucketPolicyCommand } = require('@aws-sdk/client-s3');
test(
  'real MinIO: conditional CAS, durable publication, anonymous objects and a separately restricted reader',
  { timeout: 300000 },
  async (t) => {
    const id = await docker(
      'run',
      '--detach',
      '--publish',
      '127.0.0.1::9000',
      '--env',
      'MINIO_ROOT_USER=violet-resource-admin',
      '--env',
      'MINIO_ROOT_PASSWORD=fixture-password-10919',
      '--env',
      'MINIO_API_CORS_ALLOW_ORIGIN=*',
      'violet-acceptance-minio:source-2025-10-15',
      'server',
      '/data',
    );
    t.after(() => docker('rm', '--force', id));
    const endpoint = 'http://' + (await docker('port', id, '9000/tcp'));
    for (let attempt = 0; ; attempt++) {
      try {
        if ((await fetch(endpoint + '/minio/health/ready')).ok) break;
      } catch {}
      if (attempt > 100) throw new Error('MinIO startup failed');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const credentials = { accessKeyId: 'violet-resource-admin', secretAccessKey: 'fixture-password-10919' };
    const client = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials });
    t.after(() => client.destroy());
    await client.send(new CreateBucketCommand({ Bucket: 'violet-resources' }));
    await client.send(
      new PutBucketPolicyCommand({
        Bucket: 'violet-resources',
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: '*',
              Action: ['s3:GetObject'],
              Resource: ['arn:aws:s3:::violet-resources/public/objects/*'],
            },
          ],
        }),
      }),
    );
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-minio-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const policy = path.join(root, 'reader.json');
    await fs.writeFile(
      policy,
      JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: ['s3:GetObject'],
            Resource: ['arn:aws:s3:::violet-resources/control/*', 'arn:aws:s3:::violet-resources/public/*'],
          },
          { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: ['arn:aws:s3:::violet-resources'] },
        ],
      }),
    );
    await docker(
      'run',
      '--rm',
      '--network',
      `container:${id}`,
      '--env',
      'MC_HOST_fixture=http://violet-resource-admin:fixture-password-10919@127.0.0.1:9000',
      '--volume',
      `${policy}:/policy.json:ro`,
      '--entrypoint',
      '/bin/sh',
      'violet-acceptance-minio:source-2025-10-15',
      '-c',
      'mc admin user add fixture resource-reader reader-password-10919 && mc admin policy create fixture resource-read /policy.json && mc admin policy attach fixture resource-read --user resource-reader',
    );
    const storage = new S3Storage({
      endpoint,
      region: 'us-east-1',
      bucket: 'violet-resources',
      prefix: 'cas',
      forcePathStyle: true,
      credentials,
    });
    const ref = artifactRef(new Uint8Array([1, 2, 3]), 'application/octet-stream', 'test-v1');
    const cas = new ContentAddressedStorage(storage, storage);
    assert.equal(
      (await Promise.all(Array.from({ length: 30 }, () => cas.ensure(ref, new Uint8Array([1, 2, 3]))))).filter(Boolean)
        .length,
      1,
    );
    assert.equal(await storage.compareExchange('head.json', null, new Uint8Array([1])), true);
    const doc = await storage.readDocument('head.json');
    assert.ok(doc.token);
    assert.equal(await storage.compareExchange('head.json', 'stale', new Uint8Array([2])), false);
    assert.equal(await storage.compareExchange('head.json', doc.token, new Uint8Array([2])), true);
    const file = path.join(root, 'publisher.json');
    const configuration = {
      deployment: { profile: 'sync' },
      features: { contentReads: true, contentWrites: true },
      storage: {
        backends: {
          remote: {
            driver: 's3',
            endpoint,
            region: 'us-east-1',
            bucket: 'violet-resources',
            forcePathStyle: true,
            accessKeyIdEnv: 'FIXTURE_ACCESS',
            secretAccessKeyEnv: 'FIXTURE_SECRET',
          },
        },
        mounts: {
          worlds: { backend: 'remote', prefix: 'worlds' },
          content: { backend: 'remote', prefix: 'content' },
          blobs: { backend: 'remote', prefix: 'blobs' },
        },
      },
      resources: {
        roles: ['serve', 'publish'],
        cache: { memoryBytes: 0, local: null, index: { driver: 'memory' } },
        delivery: {
          mode: 'server',
          targetMount: { backend: 'remote', prefix: 'public' },
          publicBaseUrl: endpoint + '/violet-resources/public/',
        },
        publication: { storeMount: { backend: 'remote', prefix: 'control' }, debounceMs: 60000, maxDelayMs: 60000 },
      },
    };
    await fs.writeFile(file, JSON.stringify(configuration));
    const env = {
      STATIC_API_TOKEN: 'fixture-token',
      CORS_ORIGINS: 'https://viewer.example',
      FIXTURE_ACCESS: credentials.accessKeyId,
      FIXTURE_SECRET: credentials.secretAccessKey,
    };
    const publisher = await createServices(loadServerConfig({ configFile: file, env, cwd: root }));
    let head;
    try {
      await publisher.mounts.worlds.write(
        'world/chunks/minecraft%3Aoverworld/c.0.0.nbt',
        new Uint8Array([10, 0, 0, 3, 0, 4, 120, 80, 111, 115, 0, 0, 0, 0, 3, 0, 4, 122, 80, 111, 115, 0, 0, 0, 0, 0]),
      );
      const original = new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><path d="M0 0h2v2H0z"/></svg>',
      );
      const media = await publisher.content.importMedia(original, 'image/svg+xml', 'fixture');
      const originalWrites = publisher.resources.repository.metrics.originalPut;
      await publisher.content.importMedia(original, 'image/svg+xml', 'duplicate');
      assert.equal(publisher.resources.repository.metrics.originalPut, originalWrites);
      const layer = await publisher.content.createLayer({
        schemaVersion: 1,
        layerId: 'input',
        revision: 1,
        name: 'fixture',
        features: [
          {
            featureId: 'image',
            kind: 'media',
            assetId: media.document.assetId,
            versionId: media.version.versionId,
            position: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
            views: ['top', 'player'],
            placement: 'plane',
            size: [2, 2],
            anchor: [0.5, 0.5],
          },
        ],
      });
      const map = await publisher.content.createMap({ name: 'fixture', worldKey: 'world' });
      await publisher.content.setBinding(
        map.mapId,
        'main',
        { bindingId: 'main', layerId: layer.layerId, dimension: 'minecraft:overworld', enabled: true, order: 0 },
        map.revision,
      );
      head = await publisher.resources.publication.publish(null);
      const puts = publisher.resources.target.metrics.put;
      await publisher.resources.publication.publish(head.publicationId);
      assert.equal(publisher.resources.target.metrics.put, puts);
      await publisher.resources.publication.verify();
    } finally {
      await publisher.close();
    }
    configuration.resources.roles = ['serve'];
    configuration.resources.delivery.mode = 'public';
    configuration.deployment.profile = 'public';
    configuration.features = { worldReads: false };
    await fs.writeFile(file, JSON.stringify(configuration));
    const reader = await createServices(
      loadServerConfig({
        configFile: file,
        env: { FIXTURE_ACCESS: 'resource-reader', FIXTURE_SECRET: 'reader-password-10919' },
        cwd: root,
      }),
    );
    try {
      assert.equal(reader.mounts.worlds, undefined);
      assert.equal(reader.resources.repository, undefined);
      assert.equal((await reader.resources.head()).viewId, head.publicationId);
      const result = await reader.resources.resolve(head.publicationId, [
        { kind: 'chunk', world: 'world', dimension: 'minecraft:overworld', cx: 0, cz: 0 },
      ]);
      assert.equal(new URL(result.resources[0].resource.url).origin, endpoint);
      assert.equal((await fetch(result.resources[0].resource.url)).status, 200);
      await assert.rejects(
        reader.mounts.publicationStore.create('forbidden', new Uint8Array([1]), { contentType: 'text/plain' }),
      );
    } finally {
      await reader.close();
    }
    configuration.storage.backends.remote.endpoint = endpoint.replace('127.0.0.1', 'host.docker.internal');
    await fs.writeFile(file, JSON.stringify(configuration));
    const container = await docker(
      'run',
      '--detach',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--publish',
      '127.0.0.1::3300',
      '--mount',
      `type=bind,source=${file},target=/resource-role.json,readonly`,
      '--env',
      'VIOLET_MAP_CONFIG=/resource-role.json',
      '--env',
      'FIXTURE_ACCESS=resource-reader',
      '--env',
      'FIXTURE_SECRET=reader-password-10919',
      'violet-acceptance-server',
    );
    t.after(() => docker('rm', '--force', container));
    const address = 'http://' + (await docker('port', container, '3300/tcp'));
    let observed;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch(address + '/api/resources/views/current');
        if (response.ok) {
          observed = await response.json();
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(observed?.viewId, head.publicationId, await docker('logs', container));
    assert.equal((await fetch(address + '/api/admin/resources/publications', { method: 'POST' })).status, 404);
    const inspect = JSON.parse(await docker('inspect', container))[0];
    assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
    assert.ok(inspect.Mounts.every((mount) => !mount.RW));
    await docker('stop', container);
  },
);
