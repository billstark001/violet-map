import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forEachConcurrent, mapWithConcurrency } from '../src/async.js';

test('bounded map preserves input order and never exceeds its limit', async () => {
  let active = 0;
  let peak = 0;
  const result = await mapWithConcurrency([5, 4, 3, 2, 1], 2, async (value, index) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, value));
    active--;
    return value + index;
  });
  assert.deepEqual(result, [5, 5, 5, 5, 5]);
  assert.equal(peak, 2);
});

test('a failed visit drains in-flight work before rejecting and stops scheduling', async () => {
  let active = 0;
  const started: number[] = [];
  await assert.rejects(
    forEachConcurrent([0, 1, 2], 2, async (value) => {
      started.push(value);
      active++;
      try {
        await new Promise((resolve) => setTimeout(resolve, value === 0 ? 1 : 10));
        if (value === 0) throw new Error('failed visit');
      } finally {
        active--;
      }
    }),
    /failed visit/,
  );
  assert.equal(active, 0);
  assert.deepEqual(started, [0, 1]);
});
