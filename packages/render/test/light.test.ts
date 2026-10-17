import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeColumnLight } from '../src/light.js';
import { AIR, BitArray, ChunkColumn, ChunkSection } from '@violet-map/core/domain';

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

test('light writeback spans sparse negative-height sections with independent channel ownership', () => {
  const column = new ChunkColumn(0, 0);
  column.minSectionY = -2;
  column.maxSectionY = 0;
  const packed = new BigUint64Array(256);
  const torchIndex = (15 << 8) | (8 << 4) | 8;
  packed[torchIndex >> 4] = 1n << BigInt((torchIndex & 15) * 4);
  const sky = new Uint8Array(4096).fill(7);
  column.sections.set(
    -2,
    new ChunkSection(
      -2,
      [AIR, { name: 'minecraft:torch', properties: {} }],
      new BitArray(4, packed),
      ['minecraft:plains'],
      null,
      null,
      sky,
    ),
  );
  computeColumnLight(column, (name) => ({ filter: 0, emit: name === 'minecraft:torch' ? 14 : 0 }), true, {
    writeSky: false,
  });
  assert.equal(column.sections.size, 3);
  assert.equal(column.getBlockLight(8, -17, 8), 14);
  assert.equal(column.getBlockLight(8, -16, 8), 13);
  assert.equal(column.getBlockLight(8, -15, 8), 12);
  assert.equal(column.getBlockLight(8, 0, 8), 0);
  assert.equal(column.sections.get(-2)!.skyLight, sky);
  const buffers = [...column.sections.values()].map((section) => section.blockLight!.buffer);
  assert.equal(new Set(buffers).size, 3, 'holding one section does not retain the full lighting scratch buffer');
});
