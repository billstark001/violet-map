import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nonSharedByteView, readLimitedBody } from '../src/http.js';

test('nonshared byte views preserve offsets and isolate shared backing for Web APIs', () => {
  for (const backing of [new ArrayBuffer(5), new SharedArrayBuffer(5)]) {
    const bytes = new Uint8Array(backing);
    bytes.set([99, 1, 2, 3, 88]);
    const input = bytes.subarray(1, 4);
    const view = nonSharedByteView(input);
    assert.ok(view.buffer instanceof ArrayBuffer);
    assert.deepEqual([...view], [1, 2, 3]);
    assert.equal(view.buffer === backing, backing instanceof ArrayBuffer);
    if (backing instanceof SharedArrayBuffer) {
      assert.equal(view.buffer.byteLength, 3);
      input.fill(9);
      assert.deepEqual([...view], [1, 2, 3]);
    }
  }
});

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
  assert.equal(request.bodyUsed, true);
});

test('response bodies share the limit, cancel on overflow and release failed readers', async () => {
  let cancelled = 0;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel() {
        cancelled++;
      },
    }),
  );
  assert.equal(await readLimitedBody(response, 2), null);
  assert.equal(cancelled, 1);
  assert.equal(response.body!.locked, false);
  const failed = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error('network disconnected'));
      },
    }),
  );
  await assert.rejects(readLimitedBody(failed, 2), /disconnected/);
  assert.equal(failed.body!.locked, false);
  assert.deepEqual(await readLimitedBody(new Response(null), 0), new Uint8Array());
  await assert.rejects(readLimitedBody(new Response(null), -1), RangeError);
});
