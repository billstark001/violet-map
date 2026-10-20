import { parseOverlayManifest } from '@violet-map/core/overlays';
import type { ResourceKind, ResourceRef } from '@violet-map/core/resources';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ResourceDownloader } from '../src/resources/download.js';

const bytes = new Uint8Array([1, 2, 3]);
const digest = createHash('sha256').update(bytes).digest('hex');

function ref(kind: ResourceKind = 'overlay-media'): ResourceRef {
  return {
    schemaVersion: 1,
    kind,
    artifact: { digest, bytes: 3, mediaType: 'image/png', format: 'png' },
    url: `https://resources.example/${kind}`,
  };
}

const version = {
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
};

test('overlay protocol 2 accepts one strict shared resource and rejects legacy fields', () => {
  const manifest = {
    schemaVersion: 2,
    mapId: 'm',
    mapRevision: 1,
    dimension: 'overworld',
    sourceStatus: 'verified',
    layers: [],
    media: [{ version, resource: ref() }],
  };
  assert.equal(parseOverlayManifest(manifest).media[0].resource.url, ref().url);
  for (const entry of [
    { version, url: '/api/old' },
    { version, resource: ref(), publicUrl: 'https://old.example/x' },
    { version, resource: { ...ref(), artifact: { ...ref().artifact, bytes: 4 } } },
  ])
    assert.throws(() => parseOverlayManifest({ ...manifest, media: [entry] }));
  assert.throws(() => parseOverlayManifest({ ...manifest, schemaVersion: 1 }));
});

test('all families use the same anonymous integrity transport and every failure stays on its selected URL', async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const calls: string[] = [];
  for (const kind of ['chunk', 'atlas-image', 'top-map-tile', 'overlay-media'] as ResourceKind[]) {
    globalThis.fetch = async (input, init) => {
      calls.push(String(input));
      assert.equal(init?.credentials, 'omit');
      assert.equal(init?.redirect, 'error');
      return new Response(bytes, { headers: { 'content-type': 'image/png' } });
    };
    assert.deepEqual(await new ResourceDownloader(0).download(ref(kind)), bytes);
    for (const fail of [
      async () => new Response(null, { status: 404 }),
      async () => {
        throw new TypeError('CORS/network');
      },
      async () => new Response(new Uint8Array([4, 5, 6]), { headers: { 'content-type': 'image/png' } }),
      async () => new Response(bytes, { headers: { 'content-type': 'text/plain' } }),
    ]) {
      globalThis.fetch = async (input) => {
        calls.push(String(input));
        return fail();
      };
      await assert.rejects(new ResourceDownloader(0).download(ref(kind)));
    }
  }
  assert.equal(calls.length, 20);
  assert.ok(calls.every((url) => url.startsWith('https://resources.example/')));
});

test('zero retention coalesces transfer users, cancellation releases the shared request and byte admission precedes fetch', async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  let count = 0;
  globalThis.fetch = async () => {
    count++;
    return new Response(bytes, { headers: { 'content-type': 'image/png' } });
  };
  const downloader = new ResourceDownloader(0, 3, 1);
  await Promise.all(Array.from({ length: 100 }, () => downloader.download(ref())));
  assert.equal(count, 1);
  await downloader.download(ref());
  assert.equal(count, 2);
  await assert.rejects(downloader.download({ ...ref(), artifact: { ...ref().artifact, bytes: 4 } }), {
    code: 'RESOURCE_BUSY',
  });
  assert.equal(count, 2);
  let cancelled = false;
  globalThis.fetch = async (_input, init) =>
    new Promise((_resolve, reject) =>
      init!.signal!.addEventListener(
        'abort',
        () => {
          cancelled = true;
          reject(init!.signal!.reason);
        },
        { once: true },
      ),
    );
  const controller = new AbortController();
  const pending = downloader.download(ref(), controller.signal);
  controller.abort();
  await assert.rejects(pending);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cancelled, true);
});

test('cached and coalesced downloads still enforce each reference byte length', async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  globalThis.fetch = async () => new Response(bytes, { headers: { 'content-type': 'image/png' } });
  const invalid = { ...ref(), artifact: { ...ref().artifact, bytes: 4 } };
  const cached = new ResourceDownloader();
  await cached.download(ref());
  await assert.rejects(cached.download(invalid), { code: 'RESOURCE_INTEGRITY_FAILED' });
  const zero = new ResourceDownloader(0);
  const results = await Promise.allSettled([zero.download(ref()), zero.download(invalid)]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
});
