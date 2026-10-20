import type { PublicationManifest } from '@violet-map/core/resources';
import { artifactRef } from '@violet-map/storage';
import { LocalStorage } from '@violet-map/storage/local';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PersistentResourceCache, PublicationStore } from '../src/index.js';

const manifest = (renderRoot = 'a'.repeat(64)): PublicationManifest => ({
  schemaVersion: 1,
  sourceScope: 'test',
  archiveIds: {},
  sourceScopes: {},
  renderRoot,
  worlds: [],
  entries: [],
  regions: [],
  coverage: {},
  topMaps: {},
  overlays: [],
});

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-publication-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new LocalStorage(root);
}

test('publication commits a complete closure, rejects stale parents and performs no writes for a stable manifest', async (t) => {
  const storage = await fixture(t);
  const store = new PublicationStore(storage, storage);
  let validations = 0;
  const first = await store.commit(
    manifest(),
    null,
    async () => {
      validations++;
    },
    async () => {},
  );
  const count = store.metrics.controlPut;
  assert.deepEqual(
    await store.commit(
      manifest(),
      first.publicationId,
      async () => {},
      async () => {},
    ),
    first,
  );
  assert.equal(store.metrics.controlPut, count);
  await assert.rejects(
    store.commit(
      manifest('b'.repeat(64)),
      null,
      async () => {},
      async () => {},
    ),
    { code: 'PUBLICATION_CONFLICT' },
  );
  await assert.rejects(
    store.commit(
      manifest('b'.repeat(64)),
      first.publicationId,
      async () => {},
      async () => {
        throw new Error('missing closure');
      },
    ),
    /missing closure/,
  );
  assert.deepEqual(await store.head(), first);
  assert.equal(validations, 2);
  await store.close();
});

test('a crash before head visibility leaves a recoverable prepared closure; another writer cannot enter', async (t) => {
  const storage = await fixture(t);
  const store = new PublicationStore(storage, storage);
  const compare = storage.compareExchange.bind(storage);
  storage.compareExchange = async (key, token, bytes) => {
    if (key === 'heads/current.json') throw new Error('injected head fault');
    return compare(key, token, bytes);
  };
  await assert.rejects(
    store.commit(
      manifest(),
      null,
      async () => {},
      async () => {},
    ),
    /injected/,
  );
  assert.equal(await store.head(), null);
  const second = new PublicationStore(storage, storage);
  await assert.rejects(second.acquire(), { code: 'PUBLICATION_CONFLICT' });
  storage.compareExchange = compare;
  await store.close();
  await second.recoverQuiesced();
  let verified = 0;
  assert.deepEqual(
    await second.recoverPrepared(async () => {
      verified++;
    }),
    { committed: 1, cleaned: 0 },
  );
  assert.ok(verified >= 1);
  assert.ok(await second.head());
  await second.close();
});

test('head commit success is not reported as failure when prepared cleanup fails; backup pins remain durable', async (t) => {
  const storage = await fixture(t);
  const store = new PublicationStore(storage, storage);
  const remove = storage.delete.bind(storage);
  storage.delete = async (key) => {
    if (key.startsWith('prepared/')) throw new Error('cleanup fault');
    return remove(key);
  };
  const head = await store.commit(
    manifest(),
    null,
    async () => {},
    async () => {},
  );
  assert.equal((await store.head())?.publicationId, head.publicationId);
  assert.equal(store.metrics.cleanupFailed, 1);
  storage.delete = remove;
  assert.deepEqual(await store.recoverPrepared(async () => {}), { committed: 0, cleaned: 1 });
  await store.pin('backup-1', head.publicationId);
  assert.ok(await storage.read('pins/backup-1.json'));
  await store.unpin('backup-1');
  assert.equal(await storage.read('pins/backup-1.json'), null);
  await store.close();
});

test('persistent cache has one explicit writer; read-only users never write, while corruption is an error', async (t) => {
  const storage = await fixture(t);
  const writer = new PersistentResourceCache(storage, 4096, 32, 4096);
  await writer.initialize();
  const other = new PersistentResourceCache(storage, 4096, 32, 4096);
  await assert.rejects(other.initialize(), /already has a writer/);
  const bytes = new Uint8Array([1, 2, 3]);
  const ref = artifactRef(bytes, 'image/png', 'png');
  await writer.retain('a'.repeat(64), ref, bytes);
  const readonly = new PersistentResourceCache(storage, 4096, 32, 4096, false);
  let writes = 0;
  for (const key of ['replace', 'delete', 'create', 'compareExchange'] as const) {
    const method = storage[key].bind(storage);
    (storage as any)[key] = async (...args: any[]) => {
      writes++;
      return (method as any)(...args);
    };
  }
  await readonly.initialize();
  assert.deepEqual(await readonly.read(ref), bytes);
  assert.deepEqual(await readonly.action('a'.repeat(64)), ref);
  assert.equal(await readonly.retain('b'.repeat(64), ref, bytes), false);
  await readonly.resize(0);
  await readonly.close();
  assert.equal(writes, 0);
  await writer.close();
});

test('GC retains committed public closures and backup pins while never touching retained originals', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-gc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const control = new LocalStorage(path.join(root, 'control'));
  const objects = new LocalStorage(path.join(root, 'public'));
  const originals = new LocalStorage(path.join(root, 'originals'));
  const { PublicTarget, collectPublicationGarbage } = await import('../src/index.js');
  const store = new PublicationStore(control, control);
  const target = new PublicTarget(objects, objects, 'https://resources.example/', store, ['*']);
  const liveBytes = new Uint8Array([1, 2, 3]),
    orphanBytes = new Uint8Array([4, 5, 6]);
  const live = artifactRef(liveBytes, 'image/png', 'png'),
    orphan = artifactRef(orphanBytes, 'image/png', 'png');
  await originals.write('retained-original', liveBytes);
  await target.ensure(live, liveBytes);
  await target.ensure(orphan, orphanBytes);
  const { publicObjectKey } = await import('@violet-map/storage');
  for (const ref of [live, orphan])
    await fs.utimes(path.join(root, 'public', publicObjectKey(ref)), new Date(0), new Date(0));
  const first = await store.commit(
    {
      ...manifest(),
      entries: [{ selector: { kind: 'texture', id: 'test:live' }, artifact: live, actionKey: 'c'.repeat(64) }],
    },
    null,
    async () => {},
    async () => {},
  );
  await store.pin('backup', first.publicationId);
  const result = await collectPublicationGarbage(store, target, { metadataBytes: 16384, retainedMs: 604800000 });
  assert.equal(result.deleted, 1);
  assert.ok(await target.exists(live));
  assert.equal(await target.exists(orphan), false);
  assert.deepEqual(await originals.read('retained-original'), liveBytes);
  await store.close();
});

test('every publication control commit fault preserves the old head and permits explicit recovery', async (t) => {
  for (const point of ['writer', 'prepared', 'manifest', 'retired', 'retained', 'head', 'cleanup'])
    await t.test(point, async (sub) => {
      const storage = await fixture(sub);
      const initial = new PublicationStore(storage, storage);
      const first = await initial.commit(
        manifest(),
        null,
        async () => {},
        async () => {},
      );
      await initial.close();
      const store = new PublicationStore(storage, storage);
      let failed = false;
      const match = (key: string) =>
        point === 'writer'
          ? key === 'writer.json'
          : point === 'prepared' || point === 'cleanup'
            ? key.startsWith('prepared/')
            : point === 'manifest'
              ? key.startsWith('manifests/')
              : point === 'retired'
                ? key === `retained/${first.publicationId}.json`
                : point === 'retained'
                  ? key.startsWith('retained/') && key !== `retained/${first.publicationId}.json`
                  : key === 'heads/current.json';
      const method =
        point === 'writer' || point === 'head'
          ? 'compareExchange'
          : point === 'manifest'
            ? 'create'
            : point === 'cleanup'
              ? 'delete'
              : 'replace';
      const original = storage[method].bind(storage) as (...args: any[]) => Promise<any>;
      (storage as any)[method] = async (key: string, ...args: unknown[]) => {
        if (!failed && match(key)) {
          failed = true;
          throw new Error(`fault at ${point}`);
        }
        return original(key, ...args);
      };
      const committing = store.commit(
        manifest('b'.repeat(64)),
        first.publicationId,
        async () => {},
        async () => {},
      );
      if (point === 'cleanup') {
        assert.notEqual((await committing).publicationId, first.publicationId);
        assert.equal(store.metrics.cleanupFailed, 1);
      } else {
        await assert.rejects(committing, new RegExp(`fault at ${point}`));
        assert.equal((await store.head())!.publicationId, first.publicationId);
      }
      (storage as any)[method] = original;
      await store.close();
      const recovering = new PublicationStore(storage, storage);
      await recovering.recoverQuiesced();
      await recovering.recoverPrepared(async () => {});
      const head = await recovering.head();
      assert.ok(head);
      if (['prepared', 'writer'].includes(point)) assert.equal(head.publicationId, first.publicationId);
      else assert.notEqual(head.publicationId, first.publicationId);
      await recovering.close();
    });
});
