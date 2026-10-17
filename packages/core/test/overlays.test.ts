import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseLayerDocument,
  parseMapDocument,
  normalizeContentDimension,
  parseMediaVersion,
  parseOverlayManifest,
} from '../src/overlays.js';
import { parseServiceCapabilities } from '../src/contracts.js';
const fill = { color: '#8844ff', opacity: 0.4 };
const area = {
  featureId: 'area',
  kind: 'area',
  ring: [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ],
  minY: -64,
  maxY: 320,
  fill,
  wall: { ...fill, occlusion: 'terrain' },
};
const layer = (feature: unknown) => ({
  schemaVersion: 1,
  layerId: 'layer',
  revision: 1,
  name: 'fixture',
  features: [feature],
});
test('overlay geometry rejects nonfinite, self-intersecting, touching and repeated rings', () => {
  assert.deepEqual(parseLayerDocument(layer(area)), layer(area));
  for (const ring of [
    [
      [0, 0],
      [10, 10],
      [0, 10],
      [10, 0],
    ],
    [
      [0, 0],
      [10, 0],
      [0, 0],
      [0, 10],
    ],
    [
      [0, 0],
      [10, 0],
      [5, 0],
      [0, 10],
    ],
    [
      [0, 0],
      [10, 0],
      [0, 10],
      [0, 0],
    ],
    [
      [0, 0],
      [1, 1],
      [2, 2],
    ],
  ])
    assert.throws(() => parseLayerDocument(layer({ ...area, ring })));
  for (const changes of [
    { minY: Infinity },
    { maxY: -64 },
    { fill: { ...fill, opacity: 1.01 } },
    {
      ring: [
        [0, 0],
        [NaN, 0],
        [0, 1],
      ],
    },
  ])
    assert.throws(() => parseLayerDocument(layer({ ...area, ...changes })));
  assert.throws(() => parseLayerDocument({ ...layer(area), schemaVersion: 2 }), { code: 'UNSUPPORTED_FORMAT' });
});
test('curve handles remain relative, closure does not smooth, degenerate open segments are valid', () => {
  const node = { anchor: [0, 2, 0], in: [-3, 1, 0], out: [0, 0, 0] };
  const curve = {
    featureId: 'curve',
    kind: 'curve',
    nodes: [node, node],
    closed: false,
    style: { ...fill, width: 1, widthUnit: 'blocks' },
  };
  assert.deepEqual(parseLayerDocument(layer(curve)), layer(curve));
  assert.throws(() => parseLayerDocument(layer({ ...curve, closed: true })));
  assert.throws(() => parseLayerDocument(layer({ ...curve, nodes: [node, { ...node, out: [Infinity, 0, 0] }] })));
});
test('map dimensions normalize and capabilities default new fields while retaining strict old fields', () => {
  const map = {
    schemaVersion: 1,
    mapId: 'm',
    revision: 1,
    name: 'm',
    worldKey: null,
    bindings: [{ bindingId: 'b', dimension: 'overworld', layerId: 'l', enabled: true, order: 0 }],
  };
  assert.equal(parseMapDocument(map).bindings[0].dimension, 'minecraft:overworld');
  assert.equal(normalizeContentDimension('custom:moon/deep'), 'custom:moon/deep');
  assert.throws(() => normalizeContentDimension('custom:../bad'));
  const old = {
    protocolVersion: 1,
    adminApi: true,
    users: false,
    worldWrites: true,
    dataWrites: false,
    diagnostics: false,
    authMode: 'static',
  };
  assert.equal(parseServiceCapabilities(old).contentReads, false);
  assert.throws(() => parseServiceCapabilities({ ...old, contentReads: 'yes' }));
  assert.throws(() => parseServiceCapabilities({ ...old, users: undefined }));
  assert.throws(() => parseMediaVersion({ schemaVersion: 1 }));
});

test('public manifests enforce binding identity and media lighting is a strict optional display field', () => {
  const binding = { bindingId: 'b', layerId: 'layer', dimension: 'overworld', order: 0, enabled: true };
  const manifest = {
    schemaVersion: 1,
    mapId: 'map',
    mapRevision: 1,
    dimension: 'overworld',
    sourceStatus: 'verified',
    layers: [{ binding, document: layer(area) }],
    media: [],
  };
  assert.equal(parseOverlayManifest(manifest).dimension, 'minecraft:overworld');
  for (const change of [
    { ...binding, layerId: 'other' },
    { ...binding, dimension: 'the_end' },
    { ...binding, enabled: false },
  ])
    assert.throws(() => parseOverlayManifest({ ...manifest, layers: [{ binding: change, document: layer(area) }] }));
  assert.throws(() => parseOverlayManifest({ ...manifest, layers: [...manifest.layers, ...manifest.layers] }));
  assert.throws(() => parseOverlayManifest({ ...manifest, schemaVersion: 2 }));
  const media = {
    featureId: 'media',
    kind: 'media',
    assetId: 'asset',
    versionId: 'v',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    views: ['player'],
    placement: 'model',
  };
  for (const lighting of [undefined, 'label', 'scene'])
    assert.ok(parseLayerDocument(layer({ ...media, ...(lighting ? { lighting } : {}) })));
  assert.throws(() => parseLayerDocument(layer({ ...media, lighting: 'dynamic' })));
});
