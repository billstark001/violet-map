import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AIR, BitArray, ChunkSection, parseChunkColumn } from '../src/world.js';

test('packed values decode correctly across long boundaries', () => {
  const values = new BitArray(5, new BigUint64Array([3n | (17n << 55n), 7n]));
  const decoded = new Uint8Array(14);
  values.copyTo(decoded);
  assert.equal(decoded[0], 3);
  assert.equal(decoded[11], 17);
  assert.equal(decoded[12], 7);
  assert.equal(decoded[13], 0);
  assert.equal(values.get(12), 7);
});

test('truncated packed arrays leave missing values at zero', () => {
  const values = new BitArray(4, new BigUint64Array([1n]));
  const section = new ChunkSection(
    0,
    [AIR, { name: 'minecraft:stone', properties: {} }],
    values,
    ['minecraft:plains'],
    null,
    null,
    null,
  );
  assert.equal(section.block(0, 0, 0).name, 'minecraft:stone');
  assert.equal(section.block(0, 1, 0).name, 'minecraft:air');
  assert.equal(values.get(100), 0);
  assert.throws(() => new BitArray(0, new BigUint64Array()), /bits/);
});

test('malformed section coordinates fail before an invisible chunk is accepted', () => {
  assert.throws(() => parseChunkColumn({ sections: [{ Y: undefined }] }), /section Y/);
  assert.throws(() => parseChunkColumn({ sections: [null] }), /Invalid chunk section/);
});
