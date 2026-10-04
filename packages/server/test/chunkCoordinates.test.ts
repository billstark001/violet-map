import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isChunkCoordinate, parseChunkCoordinates } from '../src/chunkCoordinates.js';

test('chunk coordinates retain signed 32-bit bounds', () => {
  assert.equal(isChunkCoordinate(-0x80000000), true);
  assert.equal(isChunkCoordinate(0x7fffffff), true);
  assert.equal(isChunkCoordinate(0x80000000), false);
  assert.equal(isChunkCoordinate(-0x80000001), false);
  assert.equal(isChunkCoordinate(1.5), false);
});

test('batch parsing rejects malformed entries before region bitwise math', () => {
  assert.deepEqual(parseChunkCoordinates({ chunks: [{ cx: -1, cz: 2 }] }, 128), [{ cx: -1, cz: 2 }]);
  assert.equal(parseChunkCoordinates({ chunks: [null] }, 128), null);
  assert.equal(parseChunkCoordinates({ chunks: [{ cx: 0x80000000, cz: 0 }] }, 128), null);
  assert.equal(parseChunkCoordinates({ chunks: 'bad' }, 128), null);
});
