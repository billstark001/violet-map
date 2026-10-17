import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CachedStorage } from '../src/cached.js';
import { LocalStorage } from '../src/local.js';
import { S3Storage } from '../src/s3.js';
import { ServerWorldStorage } from '../src/server.js';
import { syncWorld } from '../src/sync.js';
import type { StoredFileInfo, ObjectStorage } from '@violet-map/core/storage';

test('a metadata request from before a write cannot refill the cache', async () => {
  let resolveOld!: (value: StoredFileInfo | null) => void;
  const oldStat = new Promise<StoredFileInfo | null>((resolve) => {
    resolveOld = resolve;
  });
  const oldInfo = { path: 'world/region.mca', size: 1 };
  const newInfo = { path: 'world/region.mca', size: 2 };
  let statCalls = 0;
  let currentInfo = oldInfo;
  const storage = {
    kind: 'local',
    stat: async () => (++statCalls === 1 ? oldStat : currentInfo),
    write: async () => {
      currentInfo = newInfo;
    },
  } as unknown as ObjectStorage;
  const cache = new CachedStorage(storage, { statTtlMs: 60_000 });

  const stale = cache.stat(oldInfo.path);
  const staleAgain = cache.stat(oldInfo.path);
  assert.equal(statCalls, 1, 'concurrent probes share one backend request');
  await cache.write(oldInfo.path, new Uint8Array(2));
  assert.deepEqual(await cache.stat(oldInfo.path), newInfo);
  resolveOld(oldInfo);
  assert.deepEqual(await stale, oldInfo);
  assert.deepEqual(await staleAgain, oldInfo);
  assert.deepEqual(await cache.stat(oldInfo.path), newInfo);
  assert.equal(statCalls, 2);
});

test('S3 storage distinguishes absent objects from backend failures', async () => {
  const storage = new S3Storage({ bucket: 'test' });
  const fake = storage as unknown as { client: { send: () => Promise<unknown> } };
  fake.client = {
    send: async () => {
      throw { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } };
    },
  };
  assert.equal(await storage.read('missing'), null);
  assert.equal(await storage.readRange('missing', 0, 1), null);
  assert.equal(await storage.stat('missing'), null);

  fake.client = { send: async () => ({ ContentLength: 4 }) };
  assert.deepEqual(await storage.readRange('existing', 0, 0), new Uint8Array());
  await assert.rejects(storage.readRange('existing', 0, -1), RangeError);

  fake.client = {
    send: async (command: object) => {
      if (command.constructor.name === 'HeadObjectCommand') return { ContentLength: 4 };
      throw { name: 'InvalidRange', $metadata: { httpStatusCode: 416 } };
    },
  };
  assert.deepEqual(await storage.readRange('existing', 4, 1), new Uint8Array());

  const outage = new Error('S3 unavailable');
  fake.client = {
    send: async () => {
      throw outage;
    },
  };
  await assert.rejects(storage.read('world/region.mca'), outage);
  await assert.rejects(storage.readRange('world/region.mca', 0, 1), outage);
  await assert.rejects(storage.stat('world/region.mca'), outage);

  fake.client = {
    send: async () => {
      throw { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } };
    },
  };
  await assert.rejects(storage.read('world/region.mca'), { name: 'NoSuchBucket' });
});

test('local storage reads empty ranges and rejects invalid offsets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-storage-'));
  try {
    const storage = new LocalStorage(root);
    await storage.write('world/file', new Uint8Array([1, 2, 3]));
    const filesystemRoot = path.parse(root).root;
    const rooted = new LocalStorage(filesystemRoot);
    assert.deepEqual(
      await rooted.read(path.relative(filesystemRoot, path.join(root, 'world/file'))),
      new Uint8Array([1, 2, 3]),
    );
    await storage.write('world/nested/second', new Uint8Array([4]));
    assert.deepEqual(
      (await storage.list('world')).map((file) => file.path),
      ['world/file', 'world/nested/second'],
    );
    assert.deepEqual(await storage.readRange('world/file', 1, 0), new Uint8Array());
    assert.deepEqual(await storage.readRange('world/file', 1, 8), new Uint8Array([2, 3]));
    assert.deepEqual(await storage.readRange('world/file', 0, Number.MAX_SAFE_INTEGER), new Uint8Array([1, 2, 3]));
    assert.deepEqual(await storage.readRange('world/file', 3, 1), new Uint8Array());
    assert.equal(await storage.readRange('world/missing', 0, 0), null);
    await assert.rejects(storage.readRange('world/file', -1, 1), RangeError);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('remote storage maps an EOF range response to an empty read', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) =>
    String(input).includes('/stat/')
      ? Response.json({ path: 'world/file', size: 3 })
      : new Response(null, { status: 416 });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const storage = new ServerWorldStorage({ url: 'https://example.test', token: 'test' });
  assert.deepEqual(await storage.readRange('world/file', 3, 1), new Uint8Array());
});

test('remote range reads slice ignored 200 responses and retain only requested bytes', async (t) => {
  let partial = false;
  t.mock.method(globalThis, 'fetch', async (_input, init) => {
    assert.equal(new Headers(init?.headers).get('range'), 'bytes=3-4');
    return new Response(new Uint8Array(partial ? [3, 4] : [0, 1, 2, 3, 4, 5, 6, 7]), { status: partial ? 206 : 200 });
  });
  const storage = new ServerWorldStorage({ url: 'https://example.test', token: 'test' });
  for (partial of [false, true]) {
    const bytes = (await storage.readRange('world/file', 3, 2))!;
    assert.deepEqual(bytes, new Uint8Array([3, 4]));
    assert.equal(bytes.buffer.byteLength, 2);
  }
});

test('sync reuses source bytes when a same-size target file differs', async () => {
  const sourceBytes = new Uint8Array([1, 2, 3]);
  let sourceReads = 0;
  let written: Uint8Array | undefined;
  const source = {
    read: async (filePath: string) => {
      if (filePath !== 'region.mca') return null;
      sourceReads++;
      return sourceBytes;
    },
    list: async () => [{ path: 'region.mca', size: 3 }],
  } as unknown as ObjectStorage;
  const target = {
    stat: async () => ({ path: 'region.mca', size: 3 }),
    read: async () => new Uint8Array([3, 2, 1]),
    write: async (_path: string, bytes: Uint8Array) => {
      written = bytes;
    },
  } as unknown as ObjectStorage;

  const result = await syncWorld(source, target);
  assert.deepEqual(result.copied, ['region.mca']);
  assert.equal(sourceReads, 1);
  assert.equal(written, sourceBytes);
});
