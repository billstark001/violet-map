import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LocalStorage } from '@violet-map/storage/local';
import { assetDirectoryDigest, assetDirectoryRevision } from '../src/assetDigest.js';

test('asset observation reads metadata only while output dependencies retain portable content digests', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-asset-revisions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = new LocalStorage(path.join(root, 'a')),
    b = new LocalStorage(path.join(root, 'b'));
  await a.write('minecraft/models/a.json', new TextEncoder().encode('{}'));
  await b.write('minecraft/models/a.json', new TextEncoder().encode('{}'));
  let reads = 0;
  const read = LocalStorage.prototype.readRange;
  t.mock.method(LocalStorage.prototype, 'readRange', function (key: string, start: number, length: number) {
    reads++;
    return read.call(this, key, start, length);
  });
  const revision = await assetDirectoryRevision([path.join(root, 'a')]);
  assert.equal(await assetDirectoryRevision([path.join(root, 'a')]), revision);
  assert.equal(reads, 0);
  const digest = await assetDirectoryDigest([path.join(root, 'a')]);
  assert.equal(await assetDirectoryDigest([path.join(root, 'b')]), digest);
  assert.equal(reads, 2);
  await a.replace('minecraft/models/a.json', new TextEncoder().encode('{}'));
  assert.notEqual(await assetDirectoryRevision([path.join(root, 'a')]), revision);
  assert.equal(await assetDirectoryDigest([path.join(root, 'a')]), digest);
});
