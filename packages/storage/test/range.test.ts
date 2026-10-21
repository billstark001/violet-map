import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readHttpRange, readStreamRange } from '../src/range.js';
import { HttpCasStorage } from '../src/httpCas.js';
import { S3Storage } from '../src/s3.js';

test('stream ranges allocate actual bytes, preserve ownership and stop reading after the window', async () => {
  let closed = false;
  const backing = Buffer.from([0, 1, 2, 3, 4]);
  async function* chunks() {
    try {
      yield backing;
      throw new Error('read beyond requested window');
    } finally {
      closed = true;
    }
  }
  const bytes = await readStreamRange(chunks(), 2, 2);
  backing.fill(9);
  assert.deepEqual([...bytes], [2, 3]);
  assert.equal(bytes.buffer.byteLength, 2);
  assert.equal(closed, true);
  async function* short() {
    yield new Uint8Array([1, 2]);
  }
  assert.deepEqual([...(await readStreamRange(short(), 0, Number.MAX_SAFE_INTEGER))], [1, 2]);
});

test('HTTP range validation rejects a wrong offset or truncated range and cancels ignored responses', async () => {
  for (const range of [undefined, 'bytes 2-3/8', 'bytes 3-5/8', 'bytes 3-4/4']) {
    const response = new Response(new Uint8Array([3, 4]), {
      status: 206,
      headers: range ? { 'content-range': range } : {},
    });
    await assert.rejects(readHttpRange(response, 3, 2), /Content-Range/);
    assert.equal(response.body!.locked, false);
  }
  await assert.rejects(
    readHttpRange(
      new Response(new Uint8Array([3]), {
        status: 206,
        headers: { 'content-range': 'bytes 3-4/8' },
      }),
      3,
      2,
    ),
    /truncated/,
  );
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0, 1, 2, 3, 4, 5]));
    },
    cancel() {
      cancelled = true;
    },
  });
  assert.deepEqual([...(await readHttpRange(new Response(body), 3, 2))], [3, 4]);
  assert.equal(cancelled, true);
});

test('HTTP CAS obeys missing/EOF/zero-range and safe-integer rules like local and S3 storage', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).endsWith('/missing')) return new Response(null, { status: 404 });
    if (init?.method === 'HEAD') return new Response(null, { headers: { 'content-length': '2' } });
    return new Response('out of range', { status: 416 });
  });
  const storage = new HttpCasStorage('https://objects.test/');
  assert.equal(await storage.readRange('missing', 0, 0), null);
  assert.deepEqual(await storage.readRange('exists', 0, 0), new Uint8Array());
  assert.deepEqual(await storage.readRange('exists', 2, 1), new Uint8Array());
  assert.equal(await storage.readRange('missing', 2, 1), null);
  await assert.rejects(storage.readRange('exists', Number.MAX_SAFE_INTEGER, 1), RangeError);
});

test('S3 short responses tolerate a huge requested range without allocating the requested size', async () => {
  const storage = new S3Storage({ bucket: 'fixture' });
  const fake = storage as unknown as { client: { send: () => Promise<unknown> } };
  fake.client = {
    send: async () => ({
      $metadata: { httpStatusCode: 206 },
      Body: (async function* () {
        yield Buffer.from([1, 2]);
      })(),
    }),
  };
  assert.deepEqual(await storage.readRange('object', 0, Number.MAX_SAFE_INTEGER), new Uint8Array([1, 2]));
});
