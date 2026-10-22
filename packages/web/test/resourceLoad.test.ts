import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { ResourceError } from '@violet-map/core/resources';
import { loadResource } from '../src/resources/load.js';
import { RESOURCE_LOAD_TIMEOUT_MS, resourceLoadRetryDelayMs } from '../src/scheduling/resourcePolicy.js';

test('bootstrap retries selected work with backoff and never bypasses integrity failures', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const signal = new AbortController().signal;
  const work = loadResource(async (lifetime) => {
    assert.equal(lifetime.aborted, false);
    if (++calls <= 2) throw new ResourceError('RESOURCE_BUSY', 'admission is busy', true);
    return 'selected bytes';
  }, signal);
  await setImmediate();
  assert.equal(calls, 1);
  t.mock.timers.tick(249);
  await setImmediate();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(calls, 2);
  t.mock.timers.tick(500);
  assert.equal(await work, 'selected bytes');
  const invalid = new ResourceError('RESOURCE_INTEGRITY_FAILED', 'bad selected bytes');
  await assert.rejects(
    loadResource(async () => {
      throw invalid;
    }, signal),
    (error) => error === invalid,
  );
  const malformed = new TypeError('invalid selected resource document');
  await assert.rejects(
    loadResource(async () => {
      throw malformed;
    }, signal),
    (error) => error === malformed,
  );
  assert.equal(resourceLoadRetryDelayMs(100), 4000);
});

test('bootstrap cancellation revokes retry waits and late successful work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  let calls = 0;
  const work = loadResource(async () => {
    calls++;
    throw new ResourceError('RESOURCE_BUSY', 'busy', true);
  }, controller.signal);
  const rejected = assert.rejects(work, { name: 'AbortError' });
  await setImmediate();
  controller.abort();
  await rejected;
  t.mock.timers.tick(30_000);
  assert.equal(calls, 1);
  const late = new AbortController();
  let finish!: (value: string) => void;
  const pending = loadResource(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    late.signal,
  );
  late.abort();
  finish('obsolete bytes');
  await assert.rejects(pending, { name: 'AbortError' });
});

test('one bootstrap deadline applies to all retries and aborts the current transport', async (t) => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    assert.equal(ms, RESOURCE_LOAD_TIMEOUT_MS);
    return deadline.signal;
  });
  const work = loadResource(
    (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    new AbortController().signal,
  );
  deadline.abort(new DOMException('bootstrap deadline', 'TimeoutError'));
  await assert.rejects(work, { name: 'TimeoutError' });
});
