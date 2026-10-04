import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseByteRange } from '../src/httpRange.js';

test('single byte ranges include open and suffix forms', () => {
  assert.deepEqual(parseByteRange('bytes=3-5', 10), { start: 3, end: 5 });
  assert.deepEqual(parseByteRange('bytes=8-', 10), { start: 8, end: 9 });
  assert.deepEqual(parseByteRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseByteRange('bytes=-20', 10), { start: 0, end: 9 });
});

test('invalid and unsatisfiable ranges are rejected', () => {
  for (const header of ['bytes=10-', 'bytes=5-4', 'bytes=-0', 'bytes=-', 'bytes=1-2,4-5', 'bytes=1.5-3']) {
    assert.equal(parseByteRange(header, 10), null, header);
  }
  assert.equal(parseByteRange('bytes=0-', 0), null);
});
