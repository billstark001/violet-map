import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeColumnLight } from '../src/light.js';
import { AIR, BitArray, ChunkColumn, ChunkSection } from '../src/world.js';

test('single-channel light rebakes preserve the other channel', () => {
  const col = new ChunkColumn(0, 0);
  const packed = new BigUint64Array(256);
  const torchIndex = (8 << 8) | (8 << 4) | 8;
  packed[torchIndex >> 4] = 1n << BigInt((torchIndex & 15) * 4);
  const storedSky = new Uint8Array(4096).fill(5);
  const section = new ChunkSection(
    0,
    [AIR, { name: 'minecraft:torch', properties: {} }],
    new BitArray(4, packed),
    ['minecraft:plains'],
    null,
    null,
    storedSky,
  );
  col.sections.set(0, section);
  col.minSectionY = 0;
  col.maxSectionY = 0;

  const infoOf = (name: string) => ({ filter: 0, emit: name === 'minecraft:torch' ? 14 : 0 });
  computeColumnLight(col, infoOf, true, { writeSky: false, writeBlock: true });
  assert.equal(col.getBlockLight(8, 8, 8), 14);
  assert.equal(col.getBlockLight(9, 8, 8), 13);
  assert.equal(section.skyLight, storedSky);

  const storedBlock = section.blockLight;
  computeColumnLight(col, infoOf, true, { writeSky: true, writeBlock: false });
  assert.equal(section.blockLight, storedBlock);
  assert.equal(col.getSkyLight(8, 15, 8), 15);

  computeColumnLight(col, (name) => ({ filter: -10, emit: name === 'minecraft:torch' ? 1000 : 0 }), false, {
    writeBlock: true,
  });
  assert.equal(col.getBlockLight(8, 8, 8), 15);
});
