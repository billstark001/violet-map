import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { ContentAddressedStorage, artifactRef, publicObjectKey, representationKey } from '../src/contentAddressed.js';
import { StaticHttpPublisher } from '../src/staticHttpPublisher.js';
import { HttpCasStorage } from '../src/httpCas.js';

test('explicit HTTP CAS batches missing objects, conditionally commits MIME-isolated bodies and keeps credentials private', async (t) => {
  const objects = new Map<string, { bytes: Uint8Array; mediaType: string }>();
  const publicHeaders: (string | undefined)[] = [];
  let puts = 0;
  let publicMisses = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://fixture');
    const path = url.pathname;
    if (path.startsWith('/v1/')) {
      if (req.headers.authorization !== 'Bearer private-fixture-token') {
        res.writeHead(403).end();
        return;
      }
      if (path === '/v1/missing') {
        const chunks = [];
        for await (const bytes of req) chunks.push(bytes);
        const keys = JSON.parse(Buffer.concat(chunks).toString()).keys as string[];
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ missing: keys.filter((key) => !objects.has(key)) }));
        return;
      }
      if (path.startsWith('/v1/objects/')) {
        const key = path.split('/')[3];
        if (req.method === 'DELETE') {
          objects.delete(key);
          res.writeHead(204).end();
          return;
        }
        assert.equal(req.headers['if-none-match'], '*');
        if (objects.has(key)) {
          res.writeHead(412).end();
          return;
        }
        const chunks = [];
        for await (const bytes of req) chunks.push(bytes);
        objects.set(key, { bytes: Buffer.concat(chunks), mediaType: req.headers['content-type']! });
        puts++;
        res.writeHead(201).end();
        return;
      }
      if (path === '/v1/inventory') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            objects: [...objects].map(([key, value]) => ({
              path: `objects/${key.slice(0, 2)}/${key}`,
              size: value.bytes.length,
              modifiedAt: 0,
            })),
            nextCursor: '',
          }),
        );
        return;
      }
    }
    publicHeaders.push(req.headers.authorization);
    const object = objects.get(path.split('/')[3]);
    if (!object) {
      publicMisses++;
      res.writeHead(404).end();
      return;
    }
    let bytes = object.bytes;
    res.setHeader('content-type', object.mediaType);
    res.setHeader('cache-control', 'public, max-age=31536000, immutable');
    if (req.headers.range) {
      const [, start, end] = /bytes=(\d+)-(\d+)/.exec(req.headers.range)!;
      bytes = bytes.subarray(Number(start), Math.min(bytes.length, Number(end) + 1));
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${start}-${Number(start) + bytes.length - 1}/${object.bytes.length}`);
    }
    res.setHeader('content-length', bytes.length);
    res.end(req.method === 'HEAD' ? undefined : bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const image = artifactRef(bytes, 'image/png', 'png');
  const binary = artifactRef(bytes, 'application/octet-stream', 'raw-v1');
  const publisher = new StaticHttpPublisher(url, url, 'private-fixture-token');
  assert.deepEqual(
    await publisher.missing([image, binary].map(representationKey)),
    new Set([representationKey(image), representationKey(binary)]),
  );
  assert.equal(await publisher.ensure(image, bytes), true);
  assert.equal(await publisher.ensure(binary, bytes), true);
  assert.equal(await publisher.ensure(image, bytes), false);
  assert.equal(puts, 2);
  const reader = new HttpCasStorage(url);
  assert.deepEqual(await reader.readRange(publicObjectKey(image), 1, 2), new Uint8Array([2, 3]));
  assert.equal((await reader.stat(publicObjectKey(image)))!.size, 4);
  assert.ok(publicHeaders.every((value) => value === undefined));
  assert.equal(reader.create, undefined);
  assert.equal(reader.scan, undefined);
  const writer = new HttpCasStorage(url, { url, token: 'private-fixture-token' });
  const extra = artifactRef(bytes, 'application/json', 'json-v1');
  assert.equal(await new ContentAddressedStorage(writer, writer).ensure(extra, bytes, publicObjectKey(extra)), true);
  assert.equal(publicMisses, 0);
  await writer.delete(publicObjectKey(extra));
  const paths = [image, binary].map(publicObjectKey).sort((a, b) => a.localeCompare(b));
  for (const prefix of ['objects', '/objects/', './objects'])
    assert.deepEqual(
      (await writer.list(prefix)).map((item) => item.path),
      paths,
    );
  assert.equal((await writer.stat('./' + publicObjectKey(image)))!.path, publicObjectKey(image));
  await writer.delete(publicObjectKey(binary));
  assert.equal(await reader.stat(publicObjectKey(binary)), null);
});
