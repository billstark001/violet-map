import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import { decompress, parseNbt } from '../src/nbt.js';

test('NBT decompression accepts valid zlib window sizes besides the default', () => {
  const raw = new Uint8Array([10, 0, 0, 0]);
  for (const windowBits of [9, 10, 12, 15]) {
    const compressed = deflateSync(raw, { windowBits });
    assert.deepEqual(decompress(compressed), raw);
    assert.deepEqual(parseNbt(compressed), {});
  }
  assert.deepEqual(decompress(raw), raw);
});
