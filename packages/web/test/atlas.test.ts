import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AtlasIndex } from '@violet-map/core/assets';
import { collectTextureIds, fallbackTextureSize, textureAnimationData, fallbackAtlasKey } from '../src/atlas.js';

test('animation lookup frames stay within 16-bit shader offsets', () => {
  const frame = { u0: 0, v0: 0, u1: 1, v1: 1 };
  const index: AtlasIndex = {
    a: {
      ...frame,
      animation: { frames: Array(300).fill(frame), times: Array(300).fill(255) },
    },
    b: {
      ...frame,
      animation: { frames: [frame, frame], times: [1, 1] },
    },
  };
  const data = textureAnimationData(index);
  assert.equal(data.ids.a, 1);
  assert.equal(data.ids.b, undefined);
  assert.equal(data.info[6] * 256 + data.info[7], 65535);
  assert.equal(data.frameSize[1], 512);
});

test('texture collection ignores malformed optional multipart structures', () => {
  const bundle = {
    blockstates: { 'minecraft:test': { multipart: { apply: { model: 'minecraft:block/test' } } } },
    models: { 'minecraft:block/test': { parent: 42 } },
  } as unknown as Parameters<typeof collectTextureIds>[0];
  assert.deepEqual(collectTextureIds(bundle, {}), []);
});

test('fallback atlas preserves static texture dimensions and crops declared animations', () => {
  assert.deepEqual(fallbackTextureSize(32, 64, false), [32, 64]);
  assert.deepEqual(fallbackTextureSize(16, 256, false), [16, 256]);
  assert.deepEqual(fallbackTextureSize(16, 256, true), [16, 16]);
  assert.deepEqual(fallbackTextureSize(32, 16, true), [32, 16]);
});

test('fallback atlas identity tracks UVs, average colors and alpha instead of only texture names', () => {
  const a = { u0: 0, v0: 0, u1: 0.5, v1: 0.5 },
    b = { u0: 0.5, v0: 0.5, u1: 1, v1: 1 };
  const colors: Parameters<typeof fallbackAtlasKey>[1] = { a: [1, 0, 0], b: [0, 1, 0] };
  const alpha = { a: false, b: true };
  const key = fallbackAtlasKey({ a, b }, colors, alpha);
  assert.equal(fallbackAtlasKey({ b, a }, colors, alpha), key, 'dictionary order does not change layout');
  assert.notEqual(fallbackAtlasKey({ a: b, b: a }, colors, alpha), key, 'different packing must not reuse UV buffers');
  assert.notEqual(fallbackAtlasKey({ a, b }, { ...colors, a: [0, 0, 1] }, alpha), key, 'LOD colors changed');
  assert.notEqual(
    fallbackAtlasKey({ a, b }, colors, { ...alpha, a: true }),
    key,
    'texture render classification changed',
  );
});
