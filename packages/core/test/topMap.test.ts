import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildTopMapMesh,
  prepareTopMapTile,
  TOP_MAP_SCHEMA,
  type PreparedTopMapTile,
  type TopMapTilePayload,
} from '../src/mesher/topMap.js';

test('top-map mesh retains the final partial cell for non-dividing LOD steps', () => {
  const size = 5;
  const payload = {
    size: { blocks: size, samples: size, colorSamples: size, lightSamples: size },
    sampleStride: 1,
    lightStride: 1,
    minY: 0,
    approach: 'top',
  } as TopMapTilePayload;
  const data: PreparedTopMapTile = {
    payload,
    heights: new Int16Array(size * size).fill(10),
    colors: new Uint8Array(size * size * 4),
    lights: new Uint8Array(size * size * 2).fill(15),
  };
  const mesh = buildTopMapMesh(data, { step: 2 });
  assert.ok(mesh);
  assert.deepEqual(mesh.bounds?.max, [size, 10, size]);
  assert.ok(buildTopMapMesh(data, { step: size + 1 }));
});

test('decoded top-map tiles reject missing fields and fractional strides', () => {
  const payload: TopMapTilePayload = {
    schema: TOP_MAP_SCHEMA,
    kind: 'topmap-region',
    dimension: 'minecraft:overworld',
    approach: 'top',
    region: { x: 0, z: 0 },
    origin: { x: 0, z: 0 },
    size: { blocks: 512, samples: 1, colorSamples: 1, lightSamples: 1 },
    sampleStride: 512,
    colorStride: 512,
    lightStride: 512,
    chunks: 1,
    minY: 0,
    maxY: 16,
    heightEncoding: 'int16le',
    colorEncoding: 'rgba8888',
    lightEncoding: 'sky-block-u4',
    heights: new Uint8Array(2),
    colors: new Uint8Array(4),
    lights: new Uint8Array(2),
  };
  assert.equal(prepareTopMapTile(payload).heights.length, 1);
  assert.throws(() => prepareTopMapTile({ ...payload, sampleStride: 512.5 }), /bad top-map tile payload/);
  assert.throws(() => prepareTopMapTile(null as unknown as TopMapTilePayload), /bad top-map tile payload/);
});
