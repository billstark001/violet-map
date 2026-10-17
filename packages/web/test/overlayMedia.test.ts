import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { loadOverlayMedia, modelResource, validateStaticGlb } from '../src/render/overlayMedia.js';
import type { MediaFeature, MediaVersion } from '@violet-map/core/overlays';

function glb(json: unknown) {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const bytes = new Uint8Array(20 + text.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, text.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(text, 20);
  return bytes.buffer;
}

test('static GLB guard rejects unsupported extensions and dependencies, while allowing harmless metadata URLs', () => {
  validateStaticGlb(glb({ asset: { version: '2.0' }, extras: { uri: 'https://credit.example', targets: ['credit'] } }));
  for (const json of [
    { extensionsUsed: ['KHR_draco_mesh_compression'] },
    { extensionsUsed: ['EXT_meshopt_compression'] },
    { images: [{ uri: 'outside.png' }] },
    { buffers: [{ uri: 'data:application/octet-stream;base64,AA==' }] },
    { animations: [{}] },
    { skins: [{}] },
    { meshes: [{ primitives: [{ targets: [{}] }] }] },
  ])
    assert.throws(() => validateStaticGlb(glb(json)), /GLB/);
});

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
    return new Response('not pinned');
  };
  const version = {
    assetId: 'a',
    versionId: 'v',
    digest: '0'.repeat(64),
    bytes: 10,
    mediaType: 'image/png',
  } as MediaVersion;
  await assert.rejects(
    loadOverlayMedia(version, '/api/maps/m/media/a/v', new AbortController().signal, 4096),
    /digest\/size/,
  );
  await assert.rejects(
    loadOverlayMedia(
      { ...version, bytes: 100 * 1024 ** 2 },
      '/api/maps/m/media/a/v',
      new AbortController().signal,
      4096,
    ),
    /download limit/,
  );
  assert.equal(requests, 1);
  globalThis.fetch = async () => new Response(null, { status: 503 });
  await assert.rejects(
    loadOverlayMedia(version, '/api/maps/m/media/a/v', new AbortController().signal, 4096),
    /HTTP 503/,
  );
});
