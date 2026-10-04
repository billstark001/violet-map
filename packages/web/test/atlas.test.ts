import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AtlasIndex } from '@violet-map/core';
import { collectTextureIds, fallbackTextureSize, textureAnimationData } from '../src/atlas.js';

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
