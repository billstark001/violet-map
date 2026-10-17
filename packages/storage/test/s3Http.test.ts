import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { S3Storage } from '../src/s3.js';

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
