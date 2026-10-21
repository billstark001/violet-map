import { decode } from '@msgpack/msgpack';
import { sha256 } from '@violet-map/storage';
import { LocalStorage } from '@violet-map/storage/local';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadServerConfig } from '../src/configuration.js';
import { createServices } from '../src/services.js';

const dim = 'minecraft:overworld';
const nbt = new Uint8Array([
  10, 0, 0, 3, 0, 4, 120, 80, 111, 115, 0, 0, 0, 0, 3, 0, 4, 122, 80, 111, 115, 0, 0, 0, 0, 0,
]);

async function rootFixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-resources-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('bounded world observations avoid validated body reads and hash bytes when only weak metadata is available', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const root = await rootFixture(t);
  const config = loadServerConfig({
    env: {
      DEPLOYMENT_PROFILE: 'public',
      DATA_DIR: root,
      WORLDS_DIR: path.join(root, 'worlds'),
      RESOURCES_SOURCE_CONSISTENCY: 'bounded',
    },
    cwd: root,
  });
  const services = await createServices(config);
  t.after(() => services.close());
  const storage = services.mounts.worlds!;
  await storage.write('world/level.dat', new Uint8Array([1]));
  let reads = 0,
    weak = false;
  const read = storage.readRange.bind(storage),
    list = storage.list.bind(storage);
  t.mock.method(storage, 'readRange', async (...args: Parameters<typeof read>) => {
    reads++;
    return read(...args);
  });
  t.mock.method(storage, 'list', async (prefix?: string) =>
    (await list(prefix)).map((file) => (weak ? { ...file, modifiedAt: 1, etag: 'W/"same"' } : file)),
  );
  await services.resources.head('world');
  assert.equal(reads, 0);
  const release = services.resources.repository!.work.reserve(config.resources.work.memoryBytes);
  t.mock.timers.tick(5000);
  const waiting = services.resources.head('world');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(services.resources.repository!.work.queuedTasks, 1);
  release();
  await waiting;
  assert.equal(reads, 0);
  weak = true;
  t.mock.timers.tick(5000);
  const before = await services.resources.head('world');
  assert.ok(reads > 0);
  await fs.writeFile(path.join(root, 'worlds/world/level.dat'), new Uint8Array([2]));
  t.mock.timers.tick(5000);
  const after = await services.resources.head('world');
  assert.notEqual(after.generation, before.generation);
});

test('dynamic zero retention resolves and GETs deterministic chunks; source writes expire views and HEAD reads no body', async (t) => {
  const root = await rootFixture(t);
  const config = loadServerConfig({
    env: {
      DEPLOYMENT_PROFILE: 'public',
      DATA_DIR: root,
      WORLDS_DIR: path.join(root, 'worlds'),
      RESOURCES_CACHE_MEMORY_BYTES: '0',
      RESOURCES_WORK_MAX_TASKS: '1',
    },
    cwd: root,
  });
  const services = await createServices(config);
  t.after(() => services.close());
  await services.mounts.worlds!.write(`world/chunks/${encodeURIComponent(dim)}/c.0.0.nbt`, nbt);
  const app = createApp(config, services);
  const head = await services.resources.head('world');
  const before = services.resources.repository!.metrics.generation;
  const body = { viewId: head.viewId, selectors: [{ kind: 'chunk', world: 'world', dimension: dim, cx: 0, cz: 0 }] };
  const responses = await Promise.all(
    Array.from({ length: 100 }, () =>
      app.request('/api/resources/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    ),
  );
  for (const response of responses) assert.equal(response.status, 200, await response.clone().text());
  assert.equal(services.resources.repository!.metrics.generation - before, 1);
  const batch = await responses[0].json();
  const sourceChunk = (await services.worldStore!.readChunks('world', dim, [{ cx: 0, cz: 0 }]))[0]!;
  for (const field of ['terrainDigest', 'entityDigest', 'contentDigest'] as const)
    assert.equal(batch.resources[0][field], sourceChunk[field], 'source and resource identities must agree');
  const reference = batch.resources[0].resource;
  const headOnly = await app.request(reference.url, { method: 'HEAD' });
  assert.equal(headOnly.status, 200);
  assert.equal(await headOnly.text(), '');
  const response = await app.request(reference.url);
  assert.equal(response.status, 200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(sha256(bytes), reference.artifact.digest);
  const chunk = decode(bytes) as { schemaVersion: number; data: Uint8Array };
  assert.equal(chunk.schemaVersion, 1);
  assert.deepEqual(chunk.data, nbt);
  assert.equal('fileHash' in chunk, false);
  for (const url of ['chunk/0/0', 'top-map/tile/0/0'])
    assert.equal((await app.request(`/api/worlds/world/${dim}/${url}`)).status, 404);
  for (let i = 1; i < 100; i++) {
    const next = await app.request(reference.url);
    assert.equal(next.status, 200);
    assert.equal(sha256(new Uint8Array(await next.arrayBuffer())), reference.artifact.digest);
  }
  assert.equal(services.resources.repository!.metrics.generation - before, 1);
  assert.equal(services.resources.repository!.lease(reference.artifact), undefined);
  assert.equal(services.resources.repository!.cache.bytes, 0);
  assert.equal(services.resources.repository!.work.bytes, 0);
  // The same fixed action can be rebuilt after its delivery pin is consumed.
  // Its producer lease must end with the transfer, even with every cache off.
  const rebuilt = await app.request(reference.url);
  assert.equal(rebuilt.status, 200);
  assert.equal(sha256(new Uint8Array(await rebuilt.arrayBuffer())), reference.artifact.digest);
  assert.equal(services.resources.repository!.handoff.budget.bytes, 0);
  assert.equal(services.resources.repository!.work.bytes, 0);
  await services.mounts.worlds!.write(`world/chunks/${encodeURIComponent(dim)}/c.1.0.nbt`, nbt);
  const expired = await app.request('/api/resources/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(expired.status, 409);
  assert.equal((await expired.json()).code, 'RESOURCE_VIEW_EXPIRED');
  await assert.rejects(fs.stat(path.join(root, 'resource-cache')), { code: 'ENOENT' });
});

test('publisher and source-free public reader share a durable closure with zero caches and no-op publishes write nothing', async (t) => {
  const root = await rootFixture(t);
  const target = new LocalStorage(path.join(root, 'public'));
  const server = createServer(async (req, res) => {
    try {
      const key = decodeURIComponent(new URL(req.url!, 'http://localhost').pathname.slice(1));
      const bytes = await target.read(key),
        metadata = await target.httpMetadata(key);
      if (!bytes || !metadata) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-type': metadata.contentType,
        'cache-control': metadata.cacheControl!,
        'access-control-allow-origin': '*',
        'content-length': bytes.byteLength,
        etag: `"${metadata.digest}"`,
      });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const configFile = path.join(root, 'writer.json');
  const yaml = {
    deployment: { profile: 'public' },
    storage: {
      backends: {
        world: { driver: 'local', root: path.join(root, 'worlds') },
        target: { driver: 'local', root: path.join(root, 'public') },
        control: { driver: 'local', root: path.join(root, 'control') },
      },
      mounts: { worlds: { backend: 'world', prefix: '' } },
    },
    resources: {
      roles: ['serve', 'publish'],
      cache: { memoryBytes: 0 },
      delivery: { mode: 'public', targetMount: { backend: 'target', prefix: '' }, publicBaseUrl: base },
      publication: { storeMount: { backend: 'control', prefix: '' } },
    },
  };
  await fs.writeFile(configFile, JSON.stringify(yaml));
  const config = loadServerConfig({ env: {}, configFile, cwd: root });
  const writer = await createServices(config);
  t.after(() => writer.close());
  await writer.mounts.worlds!.write(`world/chunks/${encodeURIComponent(dim)}/c.0.0.nbt`, nbt);
  await writer.mounts.worlds!.write('world/region/r.0.0.mca', new Uint8Array());
  await writer.mounts.worlds!.write('world/entities/r.0.0.mca', new Uint8Array());
  const first = await writer.resources.publication.publish(null);
  const before = { ...writer.resources.store!.metrics };
  const uploads = { ...writer.resources.target!.metrics };
  const generated = writer.resources.repository!.metrics.generation;
  const second = await writer.resources.publication.publish(first.publicationId);
  assert.deepEqual(second, first);
  assert.equal(writer.resources.store!.metrics.controlPut, before.controlPut);
  assert.equal(writer.resources.target!.metrics.put, uploads.put);
  assert.equal(writer.resources.repository!.metrics.generation, generated);
  assert.equal(writer.resources.repository!.handoff.budget.bytes, 0);
  const prepared = await writer.resources.publication.prepare();
  assert.deepEqual(await writer.resources.publication.publish(second.publicationId, prepared), second);
  assert.equal(writer.resources.repository!.handoff.budget.bytes, 0);
  const writerApp = createApp(config, writer);
  await writer.mounts.worlds!.write(`draft/chunks/${encodeURIComponent(dim)}/c.0.0.nbt`, nbt);
  const beforeDrift = { ...writer.resources.target!.metrics };
  await assert.rejects(writer.resources.publication.publish(second.publicationId, prepared), {
    code: 'SOURCE_SNAPSHOT_CHANGED',
  });
  assert.equal(writer.resources.target!.metrics.put, beforeDrift.put);
  assert.deepEqual(await writer.resources.store!.head(), second);
  assert.deepEqual(
    (await (await writerApp.request('/api/worlds')).json()).map((world: { id: string }) => world.id),
    ['world'],
  );
  assert.equal((await writerApp.request('/api/worlds/draft/minecraft%3Aoverworld/chunk/0/0')).status, 404);
  assert.equal((await writer.mounts.worlds!.stat('world/region/r.0.0.mca'))?.size, 0);
  assert.equal((await writer.mounts.worlds!.stat('world/entities/r.0.0.mca'))?.size, 0);
  await writer.close();
  const readerFile = path.join(root, 'reader.json');
  await fs.writeFile(readerFile, JSON.stringify({ ...yaml, resources: { ...yaml.resources, roles: ['serve'] } }));
  const reader = await createServices(loadServerConfig({ env: {}, configFile: readerFile, cwd: root }));
  t.after(() => reader.close());
  assert.equal(reader.assets, undefined);
  assert.equal(reader.worldStore, undefined);
  assert.equal(reader.mounts.worlds, undefined);
  assert.equal(reader.resources.repository, undefined);
  const app = createApp(loadServerConfig({ env: {}, configFile: readerFile, cwd: root }), reader);
  const head = await reader.resources.head();
  assert.equal(head.mode, 'public');
  const batch = await reader.resources.resolve(head.viewId, [
    { kind: 'chunk', world: 'world', dimension: dim, cx: 0, cz: 0 },
  ]);
  const resolved = batch.resources[0];
  assert.ok('resource' in resolved);
  assert.equal(new URL(resolved.resource.url).origin, base);
  const response = await fetch(resolved.resource.url);
  assert.equal(response.status, 200);
  assert.equal(sha256(new Uint8Array(await response.arrayBuffer())), resolved.resource.artifact.digest);
  assert.equal(
    (await app.request('/api/resources/' + head.viewId + '/chunk/' + resolved.resource.artifact.digest)).status,
    404,
  );
  assert.equal((await app.request('/api/admin/resources/publications', { method: 'POST' })).status, 404);
});
