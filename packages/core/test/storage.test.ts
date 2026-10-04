import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CachedWorldStorage } from '../src/storage/cached.js';
import { LocalWorldStorage } from '../src/storage/local.js';
import { S3WorldStorage } from '../src/storage/s3.js';
import { ServerWorldStorage } from '../src/storage/server.js';
import { syncWorld } from '../src/storage/sync.js';
import type { StoredFileInfo, WorldStorage } from '../src/storage/types.js';

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
  } as unknown as WorldStorage;
  const cache = new CachedWorldStorage(storage, { statTtlMs: 60_000 });

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
  const storage = new S3WorldStorage({ bucket: 'test' });
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
    const storage = new LocalWorldStorage(root);
    await storage.write('world/file', new Uint8Array([1, 2, 3]));
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
  } as unknown as WorldStorage;
  const target = {
    stat: async () => ({ path: 'region.mca', size: 3 }),
    read: async () => new Uint8Array([3, 2, 1]),
    write: async (_path: string, bytes: Uint8Array) => {
      written = bytes;
    },
  } as unknown as WorldStorage;

  const result = await syncWorld(source, target);
  assert.deepEqual(result.copied, ['region.mca']);
  assert.equal(sourceReads, 1);
  assert.equal(written, sourceBytes);
});
