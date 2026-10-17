import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { fetchOverlayMediaBytes } from '../src/render/overlayMedia.js';
import { parseOverlayManifest, type OverlayMediaReference } from '@violet-map/core/overlays';

const bytes = new Uint8Array([1, 2, 3]);
const digest = createHash('sha256').update(bytes).digest('hex');
const reference: OverlayMediaReference = {
  version: {
    schemaVersion: 1,
    assetId: 'a',
    versionId: digest,
    digest,
    bytes: 3,
    mediaType: 'image/png',
    width: 1,
    height: 1,
    dependencies: [],
    blob: `sha256/${digest.slice(0, 2)}/${digest}`,
  },
  url: '/api/maps/m/media/a/v',
  publicUrl: 'https://media.example/blobs/file',
};

test('manifest public references validate absolute anonymous HTTP URLs without weakening API references', () => {
  const manifest = {
    schemaVersion: 1,
    mapId: 'm',
    mapRevision: 1,
    dimension: 'overworld',
    sourceStatus: 'verified',
    layers: [],
    media: [reference],
  };
  assert.deepEqual(parseOverlayManifest(manifest).media, [reference]);
  for (const publicUrl of [
    'javascript:alert(1)',
    'data:text/plain,x',
    '//media.example/x',
    '/api/x',
    'https://user:pass@media.example/x',
    'https://media.example/x#fragment',
  ])
    assert.throws(() => parseOverlayManifest({ ...manifest, media: [{ ...reference, publicUrl }] }));
  assert.throws(() => parseOverlayManifest({ ...manifest, media: [{ ...reference, url: 'https://media.example/x' }] }));
});

test('public media downloads omit credentials and use the proxy after HTTP, network, size or digest failure', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const urls: string[] = [];
  let publicResponse = () => Promise.resolve(new Response(bytes));
  globalThis.fetch = async (url, options) => {
    urls.push(String(url));
    assert.equal(options?.credentials, 'omit');
    assert.equal(options?.redirect, 'error');
    return String(url) === reference.publicUrl ? publicResponse() : new Response(bytes);
  };
  assert.deepEqual(new Uint8Array(await fetchOverlayMediaBytes(reference, new AbortController().signal)), bytes);
  assert.deepEqual(urls, [reference.publicUrl]);
  for (const response of [
    () => Promise.resolve(new Response(null, { status: 404 })),
    () => Promise.reject(new TypeError('CORS/network unavailable')),
    () => Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4]))),
    () => Promise.resolve(new Response(new Uint8Array([4, 5, 6]))),
  ]) {
    urls.length = 0;
    publicResponse = response;
    assert.deepEqual(new Uint8Array(await fetchOverlayMediaBytes(reference, new AbortController().signal)), bytes);
    assert.deepEqual(urls, [reference.publicUrl, 'http://localhost/api/maps/m/media/a/v']);
  }
  urls.length = 0;
  const controller = new AbortController();
  publicResponse = () => {
    controller.abort();
    return Promise.reject(new DOMException('cancelled', 'AbortError'));
  };
  await assert.rejects(fetchOverlayMediaBytes(reference, controller.signal), { name: 'AbortError' });
  assert.deepEqual(urls, [reference.publicUrl]);
});
