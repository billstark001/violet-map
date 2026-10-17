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

test('packed access and bulk decode match bigint extraction for every bit width and offset buffers', () => {
  let state = 0x12345678;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  for (let bits = 1; bits <= 64; bits++) {
    const backing = new BigUint64Array(6);
    for (let i = 1; i < 5; i++) backing[i] = (BigInt(next()) << 32n) | BigInt(next());
    const data = backing.subarray(1, 5);
    const values = new BitArray(bits, data);
    const perLong = Math.floor(64 / bits),
      mask = (1n << BigInt(bits)) - 1n;
    const output = new Uint16Array(perLong * data.length + 3);
    const expected = new Uint16Array(output.length);
    for (let index = 0; index < output.length; index++) {
      const long = data[Math.floor(index / perLong)] ?? 0n;
      const value = Number((long >> BigInt((index % perLong) * bits)) & mask);
      assert.equal(values.get(index), value, `bits=${bits}, index=${index}`);
      expected[index] = value;
    }
    values.copyTo(output);
    assert.deepEqual(output, expected, `bulk bits=${bits}`);
    const bytes = new Uint8Array(output.length);
    values.copyTo(bytes);
    assert.deepEqual(bytes, Uint8Array.from(expected), `byte truncation bits=${bits}`);
    assert.throws(() => values.get(0.5), RangeError);
    assert.equal(values.get(-1), 0);
  }
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

test('canonical height maps restore negative heights, wrap local coordinates and tolerate light-only boundary sections', () => {
  const bits = 5,
    perLong = Math.floor(64 / bits);
  const packed = new BigUint64Array(Math.ceil(256 / perLong));
  for (let index = 0; index < 256; index++)
    packed[Math.floor(index / perLong)] |= 16n << BigInt((index % perLong) * bits);
  const root = {
    yPos: -4,
    sections: [
      { Y: -5, SkyLight: new Uint8Array(2048) },
      { Y: -4, block_states: { palette: [{ Name: 'minecraft:stone' }] } },
    ],
    Heightmaps: { WORLD_SURFACE: packed },
  };
  const column = parseChunkColumn(root);
  assert.ok(column.heightMap);
  assert.equal(column.heightMap.bits, 5);
  assert.equal(column.heightMapOffset, -64);
  for (const [x, z] of [
    [0, 0],
    [15, 15],
    [16, 16],
    [-16, -16],
  ])
    assert.equal(column.heightAt(x, z), -48);
  for (const invalid of [packed.slice(0, 1), new BigUint64Array(packed.length), { bad: true }]) {
    const fallback = parseChunkColumn({ ...root, Heightmaps: { WORLD_SURFACE: invalid } });
    assert.equal(fallback.heightMap, null);
    assert.equal(fallback.heightAt(0, 0), -48);
  }
});
