import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import * as THREE from 'three';
import { OverlayManager, type OverlayFrame } from '../src/render/overlayManager.js';
import { createSharedUniforms } from '../src/render/materials.js';

const manifest = (id: string) => ({
  schemaVersion: 1,
  mapId: id,
  mapRevision: 1,
  dimension: 'minecraft:overworld',
  sourceStatus: 'verified',
  layers: [
    {
      binding: { bindingId: 'b', dimension: 'minecraft:overworld', layerId: 'l', enabled: true, order: 0 },
      document: {
        schemaVersion: 1,
        layerId: 'l',
        revision: 1,
        name: 'fixture',
        features: [
          {
            featureId: 'curve',
            kind: 'curve',
            nodes: [
              { anchor: [0, 0, 0], in: [0, 0, 0], out: [0, 2, 0] },
              { anchor: [4, 0, 0], in: [0, 2, 0], out: [0, 0, 0] },
            ],
            closed: false,
            style: { color: '#ff0000', opacity: 1, width: 2, widthUnit: 'pixels' },
          },
        ],
      },
    },
  ],
  media: [],
});

const renderer = { capabilities: { maxTextureSize: 4096 } } as THREE.WebGLRenderer;

function frame(): OverlayFrame {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(2, 2, 10);
  camera.lookAt(2, 0, 0);
  camera.updateProjectionMatrix();
  return {
    camera,
    topView: false,
    width: 512,
    height: 512,
    now: 1,
    dayFactor: 1,
    sky: 'normal',
    ambient: 0.18,
    surfaceMaxY: 384,
  };
}

test('context changes abort requests and ignore stale manifests, including after disable/dispose', async () => {
  const pending = new Map<string, (response: Response) => void>();
  let requests = 0;
  const manager = new OverlayManager(new THREE.Scene(), createSharedUniforms(), {
    manifest: async (path) => {
      requests++;
      return new Promise((resolve) => pending.set(path, resolve));
    },
  });
  manager.configure(null, 'overworld', true);
  assert.equal(requests, 0);
  manager.configure('old', 'overworld', true);
  manager.configure('new', 'overworld', true);
  for (const [path, resolve] of pending) resolve(Response.json(manifest(path.includes('/old/') ? 'old' : 'new')));
  await setImmediate();
  assert.equal(manager.diagnosticSnapshot().mapId, 'new');
  assert.equal(manager.diagnosticSnapshot().features, 1);
  manager.update(renderer, frame());
  assert.equal(manager.diagnosticSnapshot().active, 1);
  let geometryDisposed = 0;
  const line = manager.group.children[0] as THREE.Mesh;
  line.geometry.addEventListener('dispose', () => {
    geometryDisposed++;
  });
  manager.configure('new', 'overworld', false);
  assert.equal(manager.group.children.length, 0);
  assert.equal(geometryDisposed, 1);
  assert.equal(manager.diagnosticSnapshot().resourceBytes, 0);
  manager.dispose();
  manager.configure('another', 'overworld', true);
  assert.equal(requests, 2);
});

test('ETag refresh retains pinned revision objects and transient errors remain local to overlays', async () => {
  let calls = 0;
  const manager = new OverlayManager(new THREE.Scene(), createSharedUniforms(), {
    manifest: async (_path, init) => {
      calls++;
      if (calls === 1) return Response.json(manifest('m'), { headers: { etag: '"v1"' } });
      assert.equal(new Headers(init?.headers).get('if-none-match'), '"v1"');
      if (calls === 2) return new Response(null, { status: 304 });
      throw new Error('offline');
    },
  });
  manager.configure('m', 'overworld', true);
  await setImmediate();
  manager.update(renderer, frame());
  const object = manager.group.children[0];
  await manager.refresh();
  assert.equal(manager.group.children[0], object);
  await manager.refresh();
  assert.equal(manager.diagnosticSnapshot().features, 1);
  assert.match(manager.diagnosticSnapshot().errors[0].message, /offline/);
  manager.dispose();
  assert.equal(manager.group.children.length, 0);
});

test('a stalled manifest times out, releases loading state and can be retried', async (t) => {
  let timeout = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 30_000);
    return timeout.signal;
  });
  let calls = 0;
  const manager = new OverlayManager(new THREE.Scene(), createSharedUniforms(), {
    manifest: async (_path, init) => {
      if (++calls > 1) return Response.json(manifest('m'));
      return new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      });
    },
  });
  t.after(() => manager.dispose());
  manager.configure('m', 'overworld', true);
  assert.equal(manager.diagnosticSnapshot().loading, true);
  timeout.abort(new DOMException('overlay manifest timed out', 'TimeoutError'));
  await setImmediate();
  assert.equal(manager.diagnosticSnapshot().loading, false);
  assert.match(manager.diagnosticSnapshot().errors[0].message, /timed out/);
  timeout = new AbortController();
  await manager.refresh();
  assert.equal(manager.diagnosticSnapshot().features, 1);
  assert.deepEqual(manager.diagnosticSnapshot().errors, []);
});

test('unknown and failed media leave unrelated curves active and identify the failing feature', async () => {
  const versionId = 'a'.repeat(64);
  const base = manifest('m');
  const mediaFeature = {
    featureId: 'unknown',
    kind: 'media',
    assetId: 'asset',
    versionId,
    placement: 'plane',
    position: [2, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    size: [4, 2],
    anchor: [0.5, 0.5],
    views: ['player'],
  };
  const document = {
    ...base,
    layers: [
      {
        ...base.layers[0],
        document: { ...base.layers[0].document, features: [...base.layers[0].document.features, mediaFeature] },
      },
    ],
  };
  let known = false;
  const manager = new OverlayManager(new THREE.Scene(), createSharedUniforms(), {
    manifest: async () =>
      Response.json({
        ...document,
        media: known
          ? [
              {
                version: {
                  schemaVersion: 1,
                  assetId: 'asset',
                  versionId,
                  digest: versionId,
                  bytes: 10,
                  mediaType: 'image/png',
                  width: 4,
                  height: 2,
                  dependencies: [],
                  blob: `sha256/aa/${versionId}`,
                },
                url: `/api/maps/m/media/asset/${versionId}`,
              },
            ]
          : [],
      }),
    media: async () => {
      throw new Error('HTTP 503');
    },
  });
  manager.configure('m', 'overworld', true);
  await setImmediate();
  manager.update(renderer, frame());
  assert.equal(manager.group.children.length, 1);
  assert.match(manager.diagnosticSnapshot().errors[0].feature, /unknown/);
  assert.match(manager.diagnosticSnapshot().errors[0].message, /unknown media/);
  known = true;
  await manager.refresh();
  manager.update(renderer, frame());
  await setImmediate();
  assert.equal(manager.group.children.length, 1);
  assert.match(manager.diagnosticSnapshot().errors[0].message, /HTTP 503/);
  manager.dispose();
});
