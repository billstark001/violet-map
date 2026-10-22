import { decode } from '@msgpack/msgpack';
import type { ArtifactRef } from '@violet-map/core/resources';
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
import { createAuthentication } from '../src/authentication.js';
import { createAuthorization } from '../src/auth.js';

const dim = 'minecraft:overworld';
const nbt = new Uint8Array([
  10, 0, 0, 3, 0, 4, 120, 80, 111, 115, 0, 0, 0, 0, 3, 0, 4, 122, 80, 111, 115, 0, 0, 0, 0, 0,
]);

async function rootFixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-resources-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('an unfinished batch retains early member metadata while another owner renews its shared body pin', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const root = await rootFixture(t);
  const config = loadServerConfig({
    env: {
      DEPLOYMENT_PROFILE: 'public',
      DATA_DIR: root,
      WORLDS_DIR: path.join(root, 'worlds'),
      RESOURCES_CACHE_MEMORY_BYTES: '0',
    },
    cwd: root,
  });
  const services = await createServices(config);
  t.after(() => services.close());
  for (let cx = 0; cx < 2; cx++)
    await services.mounts.worlds!.write(`world/chunks/${encodeURIComponent(dim)}/c.${cx}.0.nbt`, nbt);
  const head = await services.resources.head('world');
  const selectors = [0, 1, 2].map((cx) => ({ kind: 'chunk' as const, world: 'world', dimension: dim, cx, cz: 0 }));
  const original = services.worldStore!.readChunks.bind(services.worldStore);
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  t.after(unblock);
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  t.mock.method(services.worldStore!, 'readChunks', async (...args: Parameters<typeof original>) => {
    if (args[2][0].cx === 1) {
      entered();
      await blocked;
    }
    return original(...args);
  });
  const repo = services.resources.repository!;
  const promise = repo.promise.bind(repo);
  let issued!: (ref: ArtifactRef) => void;
  const firstRef = new Promise<ArtifactRef>((resolve) => {
    issued = resolve;
  });
  t.mock.method(repo, 'promise', (ref: ArtifactRef) => {
    issued(ref);
    return promise(ref);
  });
  const resolving = services.resources.resolve(head.viewId, selectors.slice(0, 2));
  const [ref] = await Promise.all([firstRef, waiting]);
  t.mock.timers.tick(config.resources.work.handoffMs - 1);
  repo.renewPromise(ref);
  t.mock.timers.tick(2);
  // New membership sweeps expired metadata. The first member must remain owned
  // by its batch even though its original per-member time has elapsed.
  await services.resources.resolve(head.viewId, [selectors[2]]);
  unblock();
  const first = (await resolving).resources[0];
  assert.ok('resource' in first);
  const body = await services.resources.open(head.viewId, first.resource.kind, first.resource.artifact.digest);
  (await body.read()).release();
});

test('resolve renews the completed batch window, rejects expired intermediate pins and cancels shared owners safely', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const root = await rootFixture(t);
  const config = loadServerConfig({
    env: {
      DEPLOYMENT_PROFILE: 'public',
      DATA_DIR: root,
      WORLDS_DIR: path.join(root, 'worlds'),
      RESOURCES_CACHE_MEMORY_BYTES: '0',
    },
    cwd: root,
  });
  const services = await createServices(config);
  t.after(() => services.close());
  for (let cx = 0; cx < 2; cx++)
    await services.mounts.worlds!.write(`world/chunks/${encodeURIComponent(dim)}/c.${cx}.0.nbt`, nbt);
  const head = await services.resources.head('world');
  const selectors = [0, 1].map((cx) => ({ kind: 'chunk' as const, world: 'world', dimension: dim, cx, cz: 0 }));
  const original = services.worldStore!.readChunks.bind(services.worldStore);
  let finish!: () => void;
  const read = t.mock.method(services.worldStore!, 'readChunks', async (...args: Parameters<typeof original>) => {
    const rows = await original(...args);
    if (args[2][0].cx === 1)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return rows;
  });
  const waitReady = async () => {
    for (let i = 0; !finish || !services.resources.repository!.handoff.budget.bytes; i++) {
      if (i > 200) throw new Error('fixture generation did not reach its barrier');
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const first = services.resources.resolve(head.viewId, selectors);
  await waitReady();
  t.mock.timers.tick(5000);
  finish();
  const batch = await first;
  assert.equal(batch.validUntil, Date.now() + config.resources.work.handoffMs);
  for (const result of batch.resources)
    if ('resource' in result) (await services.resources.repository!.acquire(result.resource.artifact)).release();
  finish = undefined!;
  const expired = services.resources.resolve(head.viewId, selectors);
  await waitReady();
  t.mock.timers.tick(config.resources.work.handoffMs + 1);
  finish();
  await assert.rejects(expired, { code: 'RESOURCE_VIEW_EXPIRED' });
  assert.equal(services.resources.repository!.work.bytes, 0);
  read.mock.restore();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(services.worldStore!, 'readChunks', async (...args: Parameters<typeof original>) => {
    await gate;
    return original(...args);
  });
  const controller = new AbortController();
  const canceled = services.resources.resolve(head.viewId, [selectors[0]], controller.signal);
  const retained = services.resources.resolve(head.viewId, [selectors[0]]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(new Error('client disconnected'));
  await assert.rejects(canceled, /client disconnected/);
  release();
  const live = (await retained).resources[0];
  assert.ok('resource' in live);
  const object = await services.resources.open(head.viewId, live.resource.kind, live.resource.artifact.digest);
  (await object.read()).release();
  assert.equal(services.resources.repository!.work.bytes, 0);
  assert.equal(services.resources.repository!.handoff.budget.bytes, 0);
});

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

test('bounded observation rejects insufficient work memory before scanning source inventory', async (t) => {
  const root = await rootFixture(t);
  const config = loadServerConfig({
    env: {
      DEPLOYMENT_PROFILE: 'public',
      DATA_DIR: root,
      WORLDS_DIR: path.join(root, 'worlds'),
      RESOURCES_SOURCE_CONSISTENCY: 'bounded',
      RESOURCES_WORK_MEMORY_BYTES: '1',
    },
    cwd: root,
  });
  const services = await createServices(config);
  t.after(() => services.close());
  const list = t.mock.method(services.mounts.worlds!, 'list', async () => {
    throw new Error('observation allocated before admission');
  });
  await assert.rejects(services.resources.head('world'), { code: 'RESOURCE_BUSY' });
  assert.equal(list.mock.callCount(), 0);
});

test('bounded world observations scan requested scopes and detect changes on reactivation', async (t) => {
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
  await storage.write('first/level.dat', new Uint8Array([1]));
  await storage.write('second/level.dat', new Uint8Array([1]));
  const list = storage.list.bind(storage);
  const prefixes: (string | undefined)[] = [];
  t.mock.method(storage, 'list', async (prefix?: string) => {
    prefixes.push(prefix);
    return list(prefix);
  });
  const first = await services.resources.head('first');
  await services.resources.head('second');
  assert.deepEqual(prefixes, ['first', 'second']);
  prefixes.length = 0;
  // A world can be inactive for longer than the observation freshness window.
  t.mock.timers.tick(60000);
  await fs.writeFile(path.join(root, 'worlds/second/level.dat'), new Uint8Array([2]));
  const unchanged = await services.resources.head('first');
  assert.equal(unchanged.generation, first.generation, 'an unrelated world does not trigger request-path scans');
  assert.deepEqual(prefixes, ['first']);
  const changed = await services.resources.head('second');
  assert.ok(changed.generation > unchanged.generation, 'reactivation validates the retained fingerprint');
  assert.deepEqual(
    prefixes,
    ['first', 'second', undefined],
    'a detected change still invalidates shared source caches',
  );
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
  let base: string;
  for (let attempt = 0; ; attempt++) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      await fetch(base, { method: 'HEAD' });
      break;
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Some configured OS ephemeral ranges include Fetch-restricted ports.
      // Reject that listener before constructing the public delivery fixture.
      if (
        attempt >= 7 ||
        !(error instanceof TypeError) ||
        !(error.cause instanceof Error) ||
        error.cause.message !== 'bad port'
      )
        throw error;
    }
  }
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
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
      work: { maxTasks: 1 },
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
  const selector = { kind: 'chunk' as const, world: 'world', dimension: dim, cx: 0, cz: 0 };
  let unblock!: () => void;
  const barrier = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const ensure = writer.resources.target!.ensure.bind(writer.resources.target);
  const delayed = t.mock.method(writer.resources.target!, 'ensure', async (...args: Parameters<typeof ensure>) => {
    await barrier;
    return ensure(...args);
  });
  const adminConfig = {
    ...config,
    features: { ...config.features, adminApi: true },
    auth: { ...config.auth, mode: 'static' as const, staticToken: 'test' },
  };
  const adminApp = createApp(adminConfig, {
    ...writer,
    authorization: createAuthorization(createAuthentication(adminConfig.auth)),
  });
  assert.equal((await adminApp.request('/api/admin/resources/readiness', { method: 'POST' })).status, 401);
  const requestSignal = new AbortController();
  const acceptedResponse = await adminApp.request('/api/admin/resources/readiness', {
    method: 'POST',
    signal: requestSignal.signal,
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify({ expectedHead: null, world: 'world', selectors: [selector] }),
  });
  assert.equal(acceptedResponse.status, 202, await acceptedResponse.clone().text());
  const task = await acceptedResponse.json();
  requestSignal.abort();
  assert.equal(task.state, 'pending');
  assert.equal(task.result, undefined);
  assert.equal(writer.resources.publication.start(null, [selector], 'world').id, task.id);
  assert.throws(() => writer.resources.publication.start(null, [], 'world'), { code: 'RESOURCE_BUSY' });
  await assert.rejects(writer.resources.head(), { code: 'RESOURCE_NOT_PUBLISHED' });
  const joinedPublish = writer.resources.publication.publish(null);
  await assert.rejects(writer.resources.publication.publish('f'.repeat(64)), { code: 'RESOURCE_BUSY' });
  unblock();
  const joinedHead = await joinedPublish;
  await writer.resources.publication.drain();
  delayed.mock.restore();
  const ready = writer.resources.publication.taskStatus(task.id)!;
  const polled = await adminApp.request(acceptedResponse.headers.get('location')!, {
    headers: { authorization: 'Bearer test' },
  });
  assert.equal(polled.status, 200);
  assert.deepEqual(await polled.json(), ready);
  assert.equal(ready.state, 'ready', JSON.stringify(ready));
  assert.ok(ready.result);
  const uploaded = ready.result.resources[0];
  assert.ok('resource' in uploaded);
  assert.equal(
    sha256(new Uint8Array(await (await fetch(uploaded.resource.url)).arrayBuffer())),
    uploaded.resource.artifact.digest,
  );
  const first = (await writer.resources.store!.head())!;
  assert.deepEqual(joinedHead, first);
  assert.equal(ready.result.head.viewId, first.publicationId);
  await t.test('view lookup cancels one owner promptly while preserving a shared reader', async () => {
    const controller = new AbortController();
    let entered!: () => void, unblock!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const readHead = writer.resources.store!.head.bind(writer.resources.store);
    const slow = t.mock.method(writer.resources.store!, 'head', async () => {
      entered();
      await blocked;
      return readHead();
    });
    const canceled = writer.resources.resolve(first.publicationId, [selector], controller.signal);
    const surviving = writer.resources.resolve(first.publicationId, [selector]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await waiting;
      controller.abort(new Error('caller left during view lookup'));
      await Promise.race([
        assert.rejects(canceled, /caller left during view lookup/),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('view cancellation waited for backend IO')), 1000);
        }),
      ]);
      unblock();
      assert.ok('resource' in (await surviving).resources[0]);
    } finally {
      clearTimeout(timer);
      unblock();
      slow.mock.restore();
      await Promise.allSettled([canceled, surviving]);
    }
  });
  writer.resources.publication.start(null);
  await writer.resources.publication.drain();
  assert.equal(writer.resources.publication.taskStatus()!.error?.code, 'PUBLICATION_CONFLICT');
  assert.deepEqual(await writer.resources.store!.head(), first);
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
  assert.equal((await app.request('/api/admin/resources/readiness', { method: 'POST' })).status, 404);
  const warmFile = path.join(root, 'warm.json');
  await fs.writeFile(
    warmFile,
    JSON.stringify({
      ...yaml,
      resources: {
        ...yaml.resources,
        publication: {
          ...yaml.resources.publication,
          storeMount: { backend: 'control', prefix: 'warm' },
          warmup: 'startup',
        },
      },
    }),
  );
  const warmConfig = loadServerConfig({ env: {}, configFile: warmFile, cwd: root });
  const warm = await createServices(warmConfig);
  t.after(() => warm.close());
  await warm.resources.publication.drain();
  assert.equal(warm.resources.publication.taskStatus()!.state, 'ready');
  assert.equal((await warm.resources.head()).mode, 'public');
  await warm.resources.mutateSource(async () => {});
  let releaseVerify!: () => void, verificationStarted!: () => void;
  const verifyBarrier = new Promise<void>((resolve) => {
    releaseVerify = resolve;
  });
  const verifying = new Promise<void>((resolve) => {
    verificationStarted = resolve;
  });
  const verify = warm.resources.target!.verify.bind(warm.resources.target);
  t.mock.method(warm.resources.target!, 'verify', async (...args: Parameters<typeof verify>) => {
    const actual = verify(...args);
    verificationStarted();
    await Promise.all([actual, verifyBarrier]);
  });
  const closingTask = warm.resources.publication.start((await warm.resources.store!.head())!.publicationId);
  await verifying;
  let closed = false;
  const closing = warm.close().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false, 'shutdown drains uninterruptible anonymous verification');
  releaseVerify();
  await closing;
  assert.equal(warm.resources.publication.taskStatus(closingTask.id)!.state, 'failed');
  assert.equal(warm.resources.repository!.handoff.budget.bytes, 0);
  assert.equal(warm.resources.repository!.work.bytes, 0);
  const restarted = await createServices(warmConfig);
  t.after(() => restarted.close());
  assert.equal(restarted.resources.publication.taskStatus(), null);
  assert.equal((await restarted.resources.status()).requiresSourceSnapshot, true);
  assert.equal(
    restarted.resources.store!.metrics.controlPut,
    0,
    'startup never publishes an unfinished source synchronization',
  );
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(86400001);
  assert.throws(() => warm.resources.publication.taskStatus(closingTask.id), { code: 'RESOURCE_NOT_PUBLISHED' });
});
