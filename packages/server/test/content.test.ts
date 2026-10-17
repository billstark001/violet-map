import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalStorage } from '@violet-map/storage/local';
import { ContentService } from '../src/content.js';
import { createApp } from '../src/app.js';
import { createServices } from '../src/services.js';
import { loadServerConfig } from '../src/configuration.js';
import type { LayerDocument, MapDocument } from '@violet-map/core/overlays';
const layer = { schemaVersion: 1, layerId: 'imported', revision: 1, name: 'route', features: [] };
async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-content-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = loadServerConfig({
    env: {
      DEPLOYMENT_PROFILE: 'sync',
      STATIC_API_TOKEN: 'test',
      CONTENT_READS_ENABLED: 'true',
      CONTENT_WRITES_ENABLED: 'true',
      WORLDS_DIR: path.join(root, 'worlds'),
      DATA_DIR: root,
      CACHE_PREWARM: 'false',
    },
    cwd: root,
  });
  const services = await createServices(config, {
    database: () => {
      throw new Error('database must not open');
    },
  });
  t.after(() => services.close());
  await services.mounts.worlds.write('world/level.dat', new Uint8Array([1]));
  const app = createApp(config, services);
  const request = (url: string, method = 'GET', body?: unknown, revision?: number, token = 'test') =>
    app.request(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(revision ? { 'if-match': `"${revision}"` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { root, config, services, app, request, content: services.content! };
}
test('HTTP content lifecycle uses conditional revisions, public scope, restart and no world identity writes', async (t) => {
  const { root, config, services, request, content, app } = await fixture(t);
  assert.equal((await request('/api/admin/maps', 'GET', undefined, undefined, 'wrong')).status, 401);
  const created = await request('/api/admin/overlays/layers', 'POST', layer);
  assert.equal(created.status, 201);
  const doc = (await created.json()) as LayerDocument;
  assert.notEqual(doc.layerId, 'imported');
  assert.equal(created.headers.get('etag'), '"1"');
  assert.equal(
    (await request(`/api/admin/overlays/layers/${doc.layerId}`, 'PUT', { ...doc, revision: 2 })).status,
    428,
  );
  const updates = await Promise.all(
    [1, 2].map(() =>
      request(`/api/admin/overlays/layers/${doc.layerId}`, 'PUT', { ...doc, revision: 2, name: 'updated' }, 1),
    ),
  );
  assert.deepEqual(updates.map((r) => r.status).sort(), [200, 412]);
  const map = (await (
    await request('/api/admin/maps', 'POST', { name: 'map', worldKey: 'world' })
  ).json()) as MapDocument;
  const binding = { bindingId: 'main', dimension: 'overworld', layerId: doc.layerId, enabled: true, order: 1 };
  assert.equal((await request(`/api/admin/maps/${map.mapId}/bindings/main`, 'PUT', binding, 1)).status, 200);
  const manifest = await (await request(`/api/maps/${map.mapId}/overlays?dimension=overworld`)).json();
  assert.equal(manifest.layers[0].document.revision, 2);
  assert.equal(manifest.sourceStatus, 'unverified');
  assert.equal((await request(`/api/admin/overlays/layers/${doc.layerId}`, 'DELETE', undefined, 2)).status, 409);
  assert.equal(await services.mounts.worlds.read('world/.violet-map/identity.json'), null);
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 8"><path d="M0 0h16v8H0z" fill="#ff00ff"/></svg>',
  );
  const upload = await app.request('/api/admin/media?name=marker', {
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': 'image/svg+xml' },
    body: svg,
  });
  assert.equal(upload.status, 201);
  const asset = await upload.json();
  const feature = {
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
  };
  await content.replaceLayer(doc.layerId, { ...doc, revision: 3, features: [feature] }, 2);
  const loaded = await content.manifest(map.mapId, 'overworld');
  const file = await request(loaded.media[0].url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/svg+xml');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), svg);
  assert.equal((await request(`/api/admin/media/${asset.document.assetId}`, 'DELETE', undefined, 1)).status, 409);
  const unbound = await content.createMap({ name: 'unbound', worldKey: 'world' });
  assert.equal(
    (
      await request(
        `/api/maps/${unbound.mapId}/media/${asset.document.assetId}/${asset.version.versionId}?dimension=overworld`,
      )
    ).status,
    404,
  );
  const range = await app.request(loaded.media[0].url, { headers: { range: 'bytes=0-3' } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), '<svg');
  assert.equal(
    (await app.request(loaded.media[0].url, { headers: { 'if-none-match': file.headers.get('etag')! } })).status,
    304,
  );
  const restored = await createServices(config);
  t.after(() => restored.close());
  assert.equal((await restored.content!.manifest(map.mapId, 'overworld')).layers[0].document.revision, 3);
  await content.setBinding(map.mapId, 'main', null, 2);
  await content.deleteLayer(doc.layerId, 3);
  assert.equal((await content.getLayer(doc.layerId, 1)).name, 'route');
  await assert.rejects(fs.stat(path.join(root, 'users.pglite')), { code: 'ENOENT' });
});
test('source identity lifecycle hides overlays on replacements and preserves registrations after delete', async (t) => {
  const { services, content } = await fixture(t);
  const storage = services.mounts.worlds;
  await storage.write(
    'world/.violet-map/identity.json',
    new TextEncoder().encode(JSON.stringify({ schema: 1, id: 'archive', createdAt: 'now' })),
  );
  const map = await content.createMap({ name: 'verified', worldKey: 'world' });
  assert.equal(await content.sourceStatus(map), 'verified');
  await storage.write('copy/level.dat', new Uint8Array([1]));
  await storage.write('copy/.violet-map/identity.json', (await storage.read('world/.violet-map/identity.json'))!);
  const copy = await content.createMap({ name: 'copy', worldKey: 'copy' });
  assert.notEqual(map.mapId, copy.mapId);
  assert.deepEqual(copy.bindings, []);
  await storage.write(
    'world/.violet-map/identity.json',
    new TextEncoder().encode(JSON.stringify({ schema: 1, id: 'replacement', createdAt: 'now' })),
  );
  assert.equal((await content.manifest(map.mapId, 'overworld')).sourceStatus, 'mismatch');
  assert.deepEqual((await content.manifest(map.mapId, 'overworld')).layers, []);
  const moved = await content.replaceMap(map.mapId, { ...map, revision: 2, worldKey: 'copy' }, 1);
  assert.equal(await content.sourceStatus(moved), 'verified');
  await storage.deletePrefix('copy');
  assert.equal(await content.sourceStatus(await content.getMap(map.mapId)), 'missing');
  assert.equal(await content.sourceStatus({ ...moved, worldKey: null }), 'unbound');
});
test('head failure leaves complete old revision; reads survive restart and writer recovers', async (t) => {
  const { root, services } = await fixture(t);
  const meta = new LocalStorage(path.join(root, 'isolated-meta')),
    blobs = new LocalStorage(path.join(root, 'isolated-blobs'));
  const service = new ContentService(meta, blobs, services.mounts.worlds);
  const doc = await service.createLayer(layer);
  const replace = meta.replace.bind(meta);
  let fail = true;
  meta.replace = async (key, bytes) => {
    if (fail && key.endsWith('/head.json')) throw new Error('injected');
    await replace(key, bytes);
  };
  await assert.rejects(service.replaceLayer(doc.layerId, { ...doc, revision: 2, name: 'failed' }, 1));
  assert.equal((await service.getLayer(doc.layerId)).revision, 1);
  fail = false;
  await service.replaceLayer(doc.layerId, { ...doc, revision: 2, name: 'success' }, 1);
  assert.equal((await new ContentService(meta, blobs, services.mounts.worlds).getLayer(doc.layerId)).name, 'success');
});
test('content routes are absent when disabled, read-only never exposes mutations, permission and CORS hold', async (t) => {
  const { config, services, app } = await fixture(t);
  for (const features of [
    { ...config.features, contentReads: false, contentWrites: false },
    { ...config.features, contentWrites: false },
  ]) {
    const instance = createApp({ ...config, features }, services);
    assert.equal(
      (
        await instance.request('/api/admin/maps', {
          method: 'POST',
          headers: { authorization: 'Bearer test' },
          body: '{}',
        })
      ).status,
      404,
    );
  }
  const viewer = await createServices({ ...config, auth: { ...config.auth, staticRole: 'viewer' } });
  t.after(() => viewer.close());
  assert.equal(
    (await createApp(config, viewer).request('/api/admin/maps', { headers: { authorization: 'Bearer test' } })).status,
    403,
  );
  const cors = await app.request('/api/admin/maps', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://client.example',
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'if-match',
    },
  });
  assert.match(cors.headers.get('access-control-allow-headers') ?? '', /If-Match/i);
});

test('diagnostic credential is isolated and data/diagnostics survive a new service instance', async (t) => {
  const { config, services } = await fixture(t);
  const enabled = {
    ...config,
    features: { ...config.features, dataWrites: true, diagnostics: true },
    auth: { ...config.auth, staticRole: 'admin' as const, diagnosticsUploadToken: 'diagnostic-only' },
  };
  const instance = await createServices(enabled);
  t.after(() => instance.close());
  const app = createApp(enabled, instance);
  const headers = { authorization: 'Bearer diagnostic-only', 'content-type': 'application/json' };
  const diagnostic = await app.request('/api/diagnostics', { method: 'POST', headers, body: '{"ok":true}' });
  assert.equal(diagnostic.status, 200);
  const id = (await diagnostic.json()).id;
  assert.ok(await instance.mounts!.blobs!.read(`diagnostics/${id}.json`));
  assert.equal((await app.request('/api/admin/maps', { headers })).status, 401);
  assert.equal((await app.request('/api/data/biomes', { method: 'PUT', headers, body: '{}' })).status, 401);
  const data = { 'minecraft:plains': { name: 'persistent-test' } };
  await instance.gameData.writeDataFile('biomes.json', data);
  const restarted = await createServices(enabled);
  t.after(() => restarted.close());
  assert.deepEqual(await restarted.gameData.readBiomes(), data);
  assert.ok(await services.mounts!.blobs!.read(`diagnostics/${id}.json`));
});

test('invalid references, unknown formats and backend failures have stable HTTP errors', async (t) => {
  const { content, request, services } = await fixture(t);
  const map = await content.createMap({ name: 'map', worldKey: 'world' });
  const invalid = await request(
    `/api/admin/maps/${map.mapId}/bindings/missing`,
    'PUT',
    { bindingId: 'missing', layerId: 'missing', dimension: 'overworld', enabled: true, order: 0 },
    1,
  );
  assert.equal(invalid.status, 409);
  assert.equal((await invalid.json()).code, 'REFERENCE_CONFLICT');
  const unsupported = await request('/api/admin/overlays/layers', 'POST', { ...layer, schemaVersion: 2 });
  assert.equal(unsupported.status, 415);
  assert.equal((await unsupported.json()).code, 'UNSUPPORTED_FORMAT');
  services.mounts!.content!.list = async () => {
    throw new Error('secret-bearing backend failure');
  };
  const failed = await request('/api/admin/maps');
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).code, 'CONTENT_BACKEND_UNAVAILABLE');
  assert.equal((await request('/api/worlds')).status, 200);
});

test('failed revision/version publication never exposes orphan files or protects orphan references', async (t) => {
  const { root, services } = await fixture(t);
  const metadata = new LocalStorage(path.join(root, 'publication'));
  const service = new ContentService(
    metadata,
    new LocalStorage(path.join(root, 'publication-blobs')),
    services.mounts.worlds,
  );
  const doc = await service.createLayer(layer);
  const bytes = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>',
  );
  const asset = await service.importMedia(bytes, 'image/svg+xml', 'marker');
  const replace = metadata.replace.bind(metadata);
  metadata.replace = async (key, body) => {
    if (key === `layers/${doc.layerId}/head.json`) throw new Error('head failure');
    await replace(key, body);
  };
  const feature = {
    featureId: 'orphan',
    kind: 'media',
    assetId: asset.document.assetId,
    versionId: asset.version.versionId,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    views: ['top'],
    placement: 'plane',
    size: [1, 1],
    anchor: [0, 0],
  };
  await assert.rejects(service.replaceLayer(doc.layerId, { ...doc, revision: 2, features: [feature] }, 1));
  await assert.rejects(service.getLayer(doc.layerId, 2), { code: 'CONTENT_NOT_FOUND' });
  await service.deleteMedia(asset.document.assetId, 1);
  assert.equal(
    (await service.getMediaVersion(asset.document.assetId, asset.version.versionId)).versionId,
    asset.version.versionId,
  );
  metadata.replace = replace;
  const asset2 = await service.importMedia(bytes, 'image/svg+xml', 'second');
  metadata.replace = async (key, body) => {
    if (key === `assets/${asset2.document.assetId}/head.json`) throw new Error('asset head failure');
    await replace(key, body);
  };
  const changed = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><path d="M0 0h2v2H0z"/></svg>',
  );
  const digest = (await import('node:crypto')).createHash('sha256').update(changed).digest('hex');
  await assert.rejects(service.importMedia(changed, 'image/svg+xml', 'second', asset2.document.assetId, 1));
  await assert.rejects(service.getMediaVersion(asset2.document.assetId, digest), { code: 'CONTENT_NOT_FOUND' });
  assert.equal((await service.getMedia(asset2.document.assetId)).revision, 1);
});
