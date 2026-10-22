import { createOverlayMediaLoader } from '../src/runtime/overlayMediaLoader.js';
import type { MediaFeature, MediaVersion } from '@violet-map/core/overlays';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { decodeOverlayMedia, modelResource } from '../src/render/overlayMedia.js';

const loadMedia = createOverlayMediaLoader(decodeOverlayMedia);

test('GLB instances share immutable GPU data and close shared image bitmaps exactly once', () => {
  let closed = 0,
    textureDisposed = 0,
    geometryDisposed = 0,
    materialDisposed = 0;
  const image = {
    width: 4,
    height: 4,
    close: () => {
      closed++;
    },
  };
  const texture = new THREE.Texture(image);
  texture.addEventListener('dispose', () => {
    textureDisposed++;
  });
  const geometry = new THREE.BoxGeometry();
  geometry.addEventListener('dispose', () => {
    geometryDisposed++;
  });
  const material = new THREE.MeshStandardMaterial({ map: texture });
  material.addEventListener('dispose', () => {
    materialDisposed++;
  });
  const scene = new THREE.Group();
  scene.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material));
  const resource = modelResource(scene);
  const feature = { placement: 'model' } as MediaFeature;
  const a = resource.instantiate(feature),
    b = resource.instantiate(feature),
    label = resource.instantiate({ ...feature, lighting: 'label' });
  a.position.x = 25;
  assert.equal(b.position.x, 0);
  assert.equal((a.children[0] as THREE.Mesh).geometry, (b.children[0] as THREE.Mesh).geometry);
  assert.equal((label.children[0] as THREE.Mesh).material instanceof THREE.MeshBasicMaterial, true);
  resource.dispose();
  resource.dispose();
  assert.deepEqual(
    { closed, textureDisposed, geometryDisposed, materialDisposed },
    { closed: 1, textureDisposed: 1, geometryDisposed: 1, materialDisposed: 1 },
  );
});

test('media failures and download limits fail before optional loaders, preserving pinned content identity', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response('not pinned', { headers: { 'content-type': 'image/png' } });
  };
  const version = {
    assetId: 'a',
    versionId: 'v',
    digest: '0'.repeat(64),
    bytes: 10,
    mediaType: 'image/png',
  } as MediaVersion;
  await assert.rejects(
    loadMedia(
      {
        version,
        resource: {
          schemaVersion: 1,
          kind: 'overlay-media',
          artifact: { digest: version.digest, bytes: version.bytes, mediaType: version.mediaType, format: 'png' },
          url: '/api/resources/media',
        },
      },
      new AbortController().signal,
      4096,
    ),
    /resource (?:size|digest)/,
  );
  await assert.rejects(
    loadMedia(
      {
        version: { ...version, bytes: 100 * 1024 ** 2 },
        resource: {
          schemaVersion: 1,
          kind: 'overlay-media',
          artifact: { digest: version.digest, bytes: 100 * 1024 ** 2, mediaType: version.mediaType, format: 'png' },
          url: '/api/resources/media',
        },
      },
      new AbortController().signal,
      4096,
    ),
    /download budget/,
  );
  assert.equal(requests, 1);
  let cancelled = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(version.bytes + 1));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'content-type': 'image/png' } },
    );
  await assert.rejects(
    loadMedia(
      {
        version,
        resource: {
          schemaVersion: 1,
          kind: 'overlay-media',
          artifact: { digest: version.digest, bytes: version.bytes, mediaType: version.mediaType, format: 'png' },
          url: '/api/resources/media',
        },
      },
      new AbortController().signal,
      4096,
    ),
    /resource (?:size|digest)/,
  );
  assert.equal(cancelled, true);
  globalThis.fetch = async () => new Response(null, { status: 503 });
  await assert.rejects(
    loadMedia(
      {
        version,
        resource: {
          schemaVersion: 1,
          kind: 'overlay-media',
          artifact: { digest: version.digest, bytes: version.bytes, mediaType: version.mediaType, format: 'png' },
          url: '/api/resources/media',
        },
      },
      new AbortController().signal,
      4096,
    ),
    /HTTP 503/,
  );
});
