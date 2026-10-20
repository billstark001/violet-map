import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { S3Storage } from '../src/s3.js';

test('S3 SDK streams preserve full, partial, ignored and empty range reads', async (t) => {
  const payload = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
  const server = createServer((request, response) => {
    const key = new URL(request.url!, 'http://localhost').pathname;
    if (key.endsWith('/missing')) {
      response.writeHead(404, { 'content-type': 'application/xml' });
      response.end('<Error><Code>NoSuchKey</Code><Message>absent</Message></Error>');
      return;
    }
    if (request.method === 'HEAD') {
      response.writeHead(200, { 'content-length': payload.length });
      response.end();
      return;
    }
    if (key.endsWith('/empty')) {
      response.writeHead(200, { 'content-length': 0 });
      response.end();
      return;
    }
    const range = request.headers.range;
    if (range && !key.endsWith('/ignored')) {
      const [, from, to] = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      const start = Number(from),
        end = Math.min(Number(to), payload.length - 1);
      if (start >= payload.length) {
        response.writeHead(416, { 'content-type': 'application/xml' });
        response.end('<Error><Code>InvalidRange</Code><Message>EOF</Message></Error>');
        return;
      }
      response.writeHead(206, { 'content-range': `bytes ${start}-${end}/${payload.length}` });
      response.end(payload.subarray(start, end + 1));
      return;
    }
    response.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const storage = new S3Storage({
    bucket: 'test',
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    region: 'auto',
    credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
  });
  assert.deepEqual([...(await storage.read('full'))!], [...payload]);
  assert.equal((await storage.read('empty'))!.length, 0);
  assert.equal(await storage.read('missing'), null);
  for (const key of ['partial', 'ignored']) {
    const bytes = (await storage.readRange(key, 3, 2))!;
    assert.deepEqual([...bytes], [3, 4]);
    assert.equal(bytes.buffer.byteLength, 2);
    assert.deepEqual([...(await storage.readRange(key, 6, 20))!], [6, 7]);
    assert.equal((await storage.readRange(key, 8, 2))!.length, 0);
  }
});

test('S3 wire deletion paginates inventory and uses two SDK bulk requests for 1001 objects', async (t) => {
  const deleted: string[][] = [];
  let listRequests = 0;
  let partialFailure = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    response.setHeader('content-type', 'application/xml');
    if (request.method === 'GET') {
      listRequests++;
      assert.equal(url.searchParams.get('prefix'), 'physical/a/');
      const last = url.searchParams.has('continuation-token');
      const keys = last ? [1000] : Array.from({ length: 1000 }, (_, i) => i);
      response.end(
        `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>${!last}</IsTruncated>${last ? '' : '<NextContinuationToken>next</NextContinuationToken>'}${keys.map((i) => `<Contents><Key>physical/a/${i}</Key><Size>1</Size></Contents>`).join('')}</ListBucketResult>`,
      );
      return;
    }
    assert.equal(request.method, 'POST');
    assert.ok(url.searchParams.has('delete'));
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const keys = [...body.matchAll(/<Key>([^<]+)<\/Key>/g)].map((match) => match[1]);
    assert.ok(keys.length > 0 && keys.length <= 1000);
    assert.ok(
      request.headers['content-md5'] || request.headers['x-amz-checksum-crc32'],
      'SDK supplies a request checksum',
    );
    deleted.push(keys);
    response.end(
      `<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${partialFailure ? `<Error><Key>${keys[0]}</Key><Code>AccessDenied</Code><Message>denied</Message></Error>` : ''}</DeleteResult>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const storage = new S3Storage({
    bucket: 'test',
    prefix: 'physical',
    endpoint,
    region: 'auto',
    credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret' },
  });
  assert.equal(await storage.deletePrefix('a'), 1001);
  assert.equal(listRequests, 2);
  assert.deepEqual(
    deleted.map((keys) => keys.length).sort((a, b) => b - a),
    [1000, 1],
  );
  assert.equal(new Set(deleted.flat()).size, 1001);
  partialFailure = true;
  await assert.rejects(storage.deletePrefix('a'), AggregateError);
});

test('conditional S3 writes use opaque ETags; only 412 is a completed condition miss', async (t) => {
  const seen: { none?: string; match?: string; cache?: string }[] = [];
  let status = 200;
  const token = '"opaque-multipart-etag-17"';
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* consume the complete upload */
    }
    if (request.method === 'GET') {
      response.writeHead(200, { etag: token });
      response.end('{"revision":1}');
      return;
    }
    seen.push({
      none: request.headers['if-none-match'] as string | undefined,
      match: request.headers['if-match'] as string | undefined,
      cache: request.headers['cache-control'] as string | undefined,
    });
    response.writeHead(status, { 'content-type': 'application/xml' });
    response.end(
      status === 200
        ? ''
        : `<Error><Code>${status === 412 ? 'PreconditionFailed' : 'NotImplemented'}</Code><Message>injected</Message></Error>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const storage = new S3Storage({
    bucket: 'test',
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    region: 'auto',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const body = new Uint8Array([1, 2]);
  assert.equal(await storage.create('object', body, { contentType: 'image/png', cacheControl: 'immutable' }), true);
  const document = (await storage.readDocument('head'))!;
  assert.equal(document.token, token);
  assert.equal(await storage.compareExchange('head', document.token, body), true);
  assert.deepEqual(seen.slice(0, 2), [
    { none: '*', match: undefined, cache: 'immutable' },
    { none: undefined, match: token, cache: 'no-cache' },
  ]);
  status = 412;
  assert.equal(await storage.create('object', body, { contentType: 'image/png' }), false);
  assert.equal(await storage.compareExchange('head', null, body), false);
  status = 501;
  await assert.rejects(storage.create('object', body, { contentType: 'image/png' }));
  await assert.rejects(storage.compareExchange('head', null, body));
});
