import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  ContentAddressedStorage,
  artifactRef,
  contentObjectKey,
  publicObjectKey,
  representationKey,
} from '../src/contentAddressed.js';
import { LocalStorage } from '../src/local.js';

test('concurrent local CAS writers expose exactly one complete object; corruption is explicit', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-cas-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const local = new LocalStorage(root);
  const bytes = new TextEncoder().encode('shared original and derived bytes');
  const ref = artifactRef(bytes, 'application/octet-stream', 'raw-v1');
  const cas = new ContentAddressedStorage(local, local);
  const created = await Promise.all(Array.from({ length: 100 }, () => cas.ensure(ref, bytes)));
  assert.equal(created.filter(Boolean).length, 1);
  assert.deepEqual(await cas.read(ref), bytes);
  assert.equal(await cas.ensure(ref, bytes), false);
  assert.deepEqual(
    (await local.list()).map((item) => item.path),
    [contentObjectKey(ref.digest)],
  );
  assert.notEqual(representationKey(ref), representationKey({ ...ref, mediaType: 'image/png' }));
  assert.equal(publicObjectKey(ref), `objects/${representationKey(ref).slice(0, 2)}/${representationKey(ref)}`);
  await local.write(contentObjectKey(ref.digest), new Uint8Array(bytes.byteLength));
  await assert.rejects(cas.ensure(ref, bytes), { code: 'RESOURCE_INTEGRITY_FAILED' });
  await assert.rejects(cas.read(ref), { code: 'RESOURCE_INTEGRITY_FAILED' });
});

test('read-only CAS and unsafe keys fail explicitly without guessing another driver', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-cas-read-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const local = new LocalStorage(root);
  const bytes = new Uint8Array([1]);
  const ref = artifactRef(bytes, 'image/png', 'png');
  await assert.rejects(new ContentAddressedStorage(local).ensure(ref, bytes), /read-only/);
  assert.throws(() => contentObjectKey('../private'));
  assert.deepEqual(await fs.readdir(root), []);
});

test('conditional local documents preserve the committed head on stale token and expose lock conflicts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-head-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const local = new LocalStorage(root);
  const first = new TextEncoder().encode('{"revision":1}');
  const next = new TextEncoder().encode('{"revision":2}');
  assert.equal(await local.readDocument('head.json'), null);
  assert.equal(await local.compareExchange('head.json', null, first), true);
  const head = (await local.readDocument('head.json'))!;
  assert.equal(await local.compareExchange('head.json', null, next), false);
  assert.equal(await local.compareExchange('head.json', 'wrong-token', next), false);
  assert.deepEqual((await local.readDocument('head.json'))!.bytes, first);
  assert.equal(await local.compareExchange('head.json', head.token, next), true);
  await fs.writeFile(path.join(root, 'head.json.violet-lock'), 'explicit recovery required');
  await assert.rejects(local.compareExchange('head.json', (await local.readDocument('head.json'))!.token, first), {
    code: 'EEXIST',
  });
  assert.deepEqual((await local.readDocument('head.json'))!.bytes, next);
});
