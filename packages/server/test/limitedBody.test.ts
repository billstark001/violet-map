import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readLimitedBody } from '../src/limitedBody.js';

test('body reader accepts the exact limit and rejects overflow without buffering the rest', async () => {
  const exact = new Request('http://localhost/', { method: 'POST', body: new Uint8Array([1, 2, 3]) });
  assert.deepEqual(await readLimitedBody(exact, 3), new Uint8Array([1, 2, 3]));

  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3, 4]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const oversized = new Request('http://localhost/', {
    method: 'POST',
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  assert.equal(await readLimitedBody(oversized, 3), null);
  assert.equal(cancelled, true);
});

test('declared oversized bodies are rejected before reading', async () => {
  const request = new Request('http://localhost/', {
    method: 'POST',
    body: 'unused',
    headers: { 'content-length': '100' },
  });
  assert.equal(await readLimitedBody(request, 3), null);
  assert.equal(request.bodyUsed, false);
});
