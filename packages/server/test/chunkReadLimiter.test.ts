import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChunkReadLimiter, ChunkServiceBusyError } from '../src/chunkReadLimiter.js';

test('released slots go to queued reads without exceeding concurrency', async () => {
  const limiter = new ChunkReadLimiter(1, 2);
  let finishFirst!: () => void;
  let finishSecond!: () => void;
  const firstHold = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const secondHold = new Promise<void>((resolve) => {
    finishSecond = resolve;
  });
  const started: string[] = [];
  let active = 0;
  let peak = 0;
  const run = (name: string, hold: Promise<void>) =>
    limiter.run(async () => {
      started.push(name);
      peak = Math.max(peak, ++active);
      try {
        await hold;
      } finally {
        active--;
      }
    });

  const first = run('first', firstHold);
  const second = run('second', secondHold);
  assert.deepEqual(started, ['first']);
  finishFirst();
  const third = run('third', Promise.resolve());
  await first;
  assert.deepEqual(started, ['first', 'second']);
  finishSecond();
  await Promise.all([second, third]);
  assert.deepEqual(started, ['first', 'second', 'third']);
  assert.equal(peak, 1);
});

test('the queue limit rejects extra reads', async () => {
  const limiter = new ChunkReadLimiter(1, 1);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = limiter.run(() => hold);
  const second = limiter.run(async () => {});
  await assert.rejects(
    limiter.run(async () => {}),
    ChunkServiceBusyError,
  );
  release();
  await Promise.all([first, second]);
});
