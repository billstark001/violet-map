import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getRegionChunk } from '../src/region.js';

function regionWithRecord(length: number, sectorCount = 1): Uint8Array {
  const bytes = new Uint8Array(3 * 4096);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, (2 << 8) | sectorCount);
  view.setUint32(2 * 4096, length);
  bytes[2 * 4096 + 4] = 3;
  bytes[2 * 4096 + 5] = 42;
  return bytes;
}

test('region reader accepts an in-sector uncompressed record', () => {
  assert.deepEqual(getRegionChunk(regionWithRecord(2), 0, 0), new Uint8Array([42]));
});

test('region reader ignores truncated or sector-overlapping records', () => {
  assert.equal(getRegionChunk(regionWithRecord(4093), 0, 0), null);
  assert.equal(getRegionChunk(regionWithRecord(0), 0, 0), null);
  assert.equal(getRegionChunk(regionWithRecord(4094, 2), 0, 0), null);
  const headerPointer = regionWithRecord(2);
  new DataView(headerPointer.buffer).setUint32(0, (1 << 8) | 1);
  assert.equal(getRegionChunk(headerPointer, 0, 0), null);
  assert.equal(getRegionChunk(regionWithRecord(2), 32, 0), null);
  assert.equal(getRegionChunk(regionWithRecord(2), 0, -1), null);
});
