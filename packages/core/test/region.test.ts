import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getRegionChunk, getRegionChunkRecord, parseRegionFileName } from '../src/region.js';

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
  const region = regionWithRecord(2);
  const record = getRegionChunkRecord(region, 0, 0)!;
  assert.equal(record.compression, 3);
  assert.equal(record.payload.buffer, region.buffer);
  const decoded = getRegionChunk(region, 0, 0)!;
  assert.deepEqual(decoded, new Uint8Array([42]));
  assert.notEqual(decoded.buffer, region.buffer);
});

test('both region readers reject unsupported compression consistently', () => {
  const region = regionWithRecord(2);
  region[2 * 4096 + 4] = 4;
  assert.throws(() => getRegionChunkRecord(region, 0, 0), /Unknown region compression type 4/);
  assert.throws(() => getRegionChunk(region, 0, 0), /Unknown region compression type 4/);
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

test('region filenames stay within the signed chunk coordinate space', () => {
  assert.deepEqual(parseRegionFileName('r.-67108864.67108863.mca'), { x: -67108864, z: 67108863 });
  assert.deepEqual(parseRegionFileName('r.-1.0.mca'), { x: -1, z: 0 });
  for (const name of [
    'r.67108864.0.mca',
    'r.-67108865.0.mca',
    'r.999999999999999999999999.0.mca',
    'r.1.5.0.mca',
    '../r.0.0.mca',
    'r.0.0.mca.bak',
    'r.NaN.0.mca',
  ])
    assert.equal(parseRegionFileName(name), null, name);
});
