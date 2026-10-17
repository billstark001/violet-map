import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packIndices } from '../src/meshPacking.js';

test('index packing uses 16 bits through exactly 65536 vertices and respects input offsets', () => {
  const values = new Uint32Array([99, 0, 32_768, 65_535, 88]).subarray(1, 4);
  for (const count of [65_536]) {
    const packed = packIndices(values, count);
    assert.ok(packed instanceof Uint16Array);
    assert.deepEqual([...packed], [0, 32_768, 65_535]);
    assert.equal(packed.buffer.byteLength, 6);
  }
  assert.ok(packIndices(new Uint32Array([65_534]), 65_535) instanceof Uint16Array);
  assert.equal(packIndices(values, 65_537), values, 'larger meshes retain their 32-bit indices without copying');
});
