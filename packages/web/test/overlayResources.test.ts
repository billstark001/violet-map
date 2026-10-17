import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { OverlayResourcePool } from '../src/render/overlayResources.js';
test('media resources coalesce loads and dispose exactly once after the last owner', async () => {
  let loads = 0,
    disposed = 0;
  const pool = new OverlayResourcePool();
  const load = async () => {
    loads++;
    return {
      bytes: 20,
      dispose: () => {
        disposed++;
      },
    };
  };
  const a = pool.acquire('pinned-v1', load),
    b = pool.acquire('pinned-v1', load);
  assert.equal(await a.promise, await b.promise);
  assert.equal(loads, 1);
  a.release();
  assert.equal(disposed, 0);
  assert.equal(pool.snapshot().bytes, 20);
  b.release();
  assert.equal(disposed, 1);
  assert.equal(pool.snapshot().versions, 0);
  assert.equal(pool.snapshot().bytes, 0);
  b.release();
  pool.dispose();
  assert.equal(disposed, 1);
});
test('late decodes are destroyed after abort/context disposal and cannot replace a new version', async () => {
  const pool = new OverlayResourcePool();
  let finish!: (value: { bytes: number; dispose: () => void }) => void,
    disposed = 0;
  const old = pool.acquire(
    'v1',
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await setImmediate();
  old.release();
  const next = pool.acquire('v2', async () => ({
    bytes: 10,
    dispose: () => {
      disposed++;
    },
  }));
  await next.promise;
  finish({
    bytes: 50,
    dispose: () => {
      disposed++;
    },
  });
  await assert.rejects(old.promise, { name: 'AbortError' });
  assert.equal(pool.snapshot().bytes, 10);
  assert.equal(disposed, 1);
  pool.dispose();
  next.release();
  assert.equal(disposed, 2);
  assert.equal(pool.snapshot().bytes, 0);
});
test('concurrency, version and byte budgets are bounded; one failure does not poison other keys', async () => {
  const pool = new OverlayResourcePool(10, 2, 1);
  let resolve!: (value: { bytes: number; dispose: () => void }) => void;
  const a = pool.acquire(
      'a',
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    ),
    b = pool.acquire('b', async () => ({ bytes: 2, dispose: () => {} }));
  assert.throws(() => pool.acquire('c', async () => ({ bytes: 1, dispose: () => {} })), /version budget/);
  await setImmediate();
  assert.equal(pool.snapshot().pending, 2);
  let freed = 0;
  resolve({
    bytes: 20,
    dispose: () => {
      freed++;
    },
  });
  await assert.rejects(a.promise, /GPU resource budget/);
  await b.promise;
  assert.equal(freed, 1);
  assert.equal(pool.snapshot().bytes, 2);
  b.release();
  a.release();
  pool.dispose();
});
