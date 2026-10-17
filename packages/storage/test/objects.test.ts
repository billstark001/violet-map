import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LocalStorage } from '../src/local.js';
import { ScopedStorage } from '../src/prefixed.js';
import { CachedStorage } from '../src/cached.js';
import { S3Storage } from '../src/s3.js';
import { copyObjects, compareObjectContent } from '../src/copy.js';

const bytes = (s: string) => new TextEncoder().encode(s);

test('scopes, descendant prefixes, atomic replacement and copy share the object contract', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-objects-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = new LocalStorage(root);
  const nested = new CachedStorage(new ScopedStorage(new ScopedStorage(storage, 'a'), 'nested'));
  await storage.write('a/sibling', bytes('untouched'));
  await storage.write('ab/file', bytes('untouched'));
  await storage.write('a/nested/same', bytes('same-name object'));
  await nested.write('folder/file', bytes('one'));
  assert.deepEqual(
    (await nested.list()).map((f) => f.path),
    ['folder/file', 'same'],
  );
  assert.equal((await nested.stat('folder/file'))?.path, 'folder/file');
  assert.deepEqual(await nested.listDirectories(), ['folder']);
  assert.throws(() => nested.read('../sibling'));
  assert.equal(await nested.deletePrefix('same'), 0);
  assert.ok(await nested.read('same'));
  const old = JSON.stringify({ data: 'old'.repeat(10000) }),
    next = JSON.stringify({ data: 'new'.repeat(10000) });
  await nested.replace('document', bytes(old));
  await Promise.all([
    nested.replace('document', bytes(next)),
    ...Array.from({ length: 30 }, async () => {
      const value = new TextDecoder().decode((await nested.read('document'))!);
      assert.ok(value === old || value === next);
      JSON.parse(value);
    }),
  ]);
  const target = new ScopedStorage(storage, 'copy');
  const result = await copyObjects(nested, target);
  assert.equal(result.copied.length, 3);
  assert.equal((await copyObjects(nested, target)).skipped.length, 3);
  await nested.deletePrefix('folder');
  assert.ok(await storage.read('ab/file'));
  assert.ok(await storage.read('a/sibling'));
});

test('S3 directory prefixes never list or delete same-name or sibling objects; writes publish one PUT', async () => {
  const storage = new S3Storage({ bucket: 'test', prefix: 'physical' });
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const fake = storage as unknown as {
    client: { send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => Promise<unknown> };
  };
  fake.client = {
    send: async (command) => {
      calls.push({ name: command.constructor.name, input: command.input });
      return command.constructor.name === 'ListObjectsV2Command'
        ? { Contents: [{ Key: 'physical/a/file', Size: 2 }] }
        : {};
    },
  };
  await storage.deletePrefix('a');
  assert.equal(calls[0].input.Prefix, 'physical/a/');
  assert.deepEqual(calls[1].input.Delete, { Quiet: true, Objects: [{ Key: 'physical/a/file' }] });
  calls.length = 0;
  await storage.replace('head', bytes('{}'), 'application/json');
  assert.deepEqual(
    calls.map((c) => c.name),
    ['PutObjectCommand'],
  );
});

test('metadata caches bound unique misses and total list items without changing returned data', async () => {
  let calls = 0;
  const storage = {
    kind: 'local' as const,
    stat: async () => {
      calls++;
      return null;
    },
    list: async (prefix = '') => {
      calls++;
      return Array.from({ length: prefix === 'large' ? 4 : 1 }, (_, i) => ({ path: `${prefix}/${i}`, size: i }));
    },
    listDirectories: async () => {
      calls++;
      return ['one', 'two'];
    },
  } as unknown as import('@violet-map/core/storage').ObjectStorage;
  const cache = new CachedStorage(storage, { maxEntries: 2, maxListItems: 3 });
  await cache.stat('a');
  await cache.stat('b');
  await cache.stat('a');
  assert.equal(calls, 2);
  await cache.stat('c');
  await cache.stat('b');
  assert.equal(calls, 4, 'least-recently-used negative probes must be evicted');
  calls = 0;
  assert.equal((await cache.list('large')).length, 4);
  assert.equal((await cache.list('large')).length, 4);
  assert.equal(calls, 2, 'oversized lists must not be retained');
  await cache.listDirectories('a');
  await cache.listDirectories('b');
  await cache.listDirectories('a');
  assert.equal(calls, 5, 'list item budgets apply across all cached prefixes');
});

test('canonical metadata keys coalesce equivalent directory and object paths', async () => {
  let stats = 0,
    lists = 0,
    directories = 0;
  const backend = {
    kind: 'local',
    stat: async () => {
      stats++;
      return null;
    },
    list: async () => {
      lists++;
      return [];
    },
    listDirectories: async () => {
      directories++;
      return [];
    },
  } as unknown as import('@violet-map/core/storage').ObjectStorage;
  const cache = new CachedStorage(backend);
  await Promise.all(['a/file', '/a//file', 'a/./file'].map((path) => cache.stat(path)));
  await Promise.all(['', '/', '.'].map((path) => cache.list(path)));
  await Promise.all(['a', '/a/', './a'].map((path) => cache.listDirectories(path)));
  assert.deepEqual({ stats, lists, directories }, { stats: 1, lists: 1, directories: 1 });
});

test('S3 normalizes root-equivalent prefixes and reports per-object bulk errors', async () => {
  const storage = new S3Storage({ bucket: 'test', prefix: 'physical' });
  const prefixes: unknown[] = [];
  let fail = false;
  const client = storage as unknown as {
    client: { send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => Promise<unknown> };
  };
  client.client = {
    send: async (command) => {
      if (command.constructor.name === 'ListObjectsV2Command') {
        prefixes.push(command.input.Prefix);
        return { Contents: [{ Key: 'physical/file' }], CommonPrefixes: [{ Prefix: 'physical/directory/' }] };
      }
      return fail ? { Errors: [{ Key: 'physical/file', Code: 'AccessDenied' }] } : {};
    },
  };
  for (const root of ['', '/', '.', './']) {
    assert.equal((await storage.list(root))[0].path, 'file');
    assert.deepEqual(await storage.listDirectories(root), ['directory']);
  }
  assert.ok(prefixes.every((prefix) => prefix === 'physical/'));
  fail = true;
  await assert.rejects(storage.deletePrefix(''), AggregateError);
});

test('content comparison hashes only the supplied view and accepts shared backing', async () => {
  const source = new Uint8Array([99, 1, 2, 3, 88]).subarray(1, 4);
  const target = new Uint8Array([55, 1, 2, 3, 66]).subarray(1, 4);
  const shared = new Uint8Array(new SharedArrayBuffer(3));
  shared.set(source);
  const storage = (bytes: Uint8Array) =>
    ({
      stat: async () => ({ path: 'object', size: bytes.length }),
      read: async () => bytes,
    }) as Parameters<typeof compareObjectContent>[0];
  assert.equal((await compareObjectContent(storage(source), storage(target), 'object', 3)).same, true);
  assert.equal((await compareObjectContent(storage(source), storage(shared), 'object', 3)).same, true);
  assert.equal(
    (await compareObjectContent(storage(source), storage(Buffer.from(shared.buffer)), 'object', 3)).same,
    true,
  );
  shared[2] = 4;
  const changed = await compareObjectContent(storage(source), storage(shared), 'object', 3);
  assert.equal(changed.same, false);
  assert.equal(changed.sourceBytes, source);
});
