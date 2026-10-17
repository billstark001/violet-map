import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ModelBaker } from '../../packages/render/src/model.js';
import type { AssetBundle, Direction } from '../../packages/core/src/assets.js';

const directions: Direction[] = ['up', 'down', 'north', 'south', 'west', 'east'];
const bundle: AssetBundle = {
  blockstates: {},
  models: {
    'bench:entity': {
      textures: { all: 'bench:texture' },
      elements: [
        {
          from: [1, 0, 1],
          to: [15, 10, 15],
          faces: Object.fromEntries(directions.map((direction) => [direction, { texture: '#all' }])),
        },
        {
          from: [1, 10, 1],
          to: [15, 14, 15],
          faces: Object.fromEntries(directions.map((direction) => [direction, { texture: '#all' }])),
        },
      ],
    },
  },
};
const baker = new ModelBaker(bundle);
const timings: number[] = [];
let expected = '';

for (let round = 0; round < 35; round++) {
  let quads = baker.getModelQuads('bench:entity');
  const start = performance.now();
  for (let instance = 0; instance < 1000; instance++) quads = baker.getModelQuads('bench:entity');
  const elapsed = performance.now() - start;
  assert.equal(quads.length, 12);
  const hash = createHash('sha256');
  for (const quad of quads) {
    hash.update(new Uint8Array(quad.positions.buffer, quad.positions.byteOffset, quad.positions.byteLength));
    hash.update(new Uint8Array(quad.uvs.buffer, quad.uvs.byteOffset, quad.uvs.byteLength));
    hash.update(quad.texture);
  }
  const digest = hash.digest('hex');
  if (expected) assert.equal(digest, expected);
  else expected = digest;
  if (round >= 5) timings.push(elapsed);
}

timings.sort((a, b) => a - b);

console.log(
  JSON.stringify(
    {
      node: process.version,
      instancesPerRound: 1000,
      measuredRounds: 30,
      includes: 'registered 12-quad entity model lookup/baking; instance transforms and meshing excluded',
      p50Ms: timings[15],
      p95Ms: timings[28],
      digest: expected,
    },
    null,
    2,
  ),
);
