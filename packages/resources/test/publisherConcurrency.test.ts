import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { LocalStorage } from '@violet-map/storage/local';
import { ResourcePublisher } from '../src/publisher.js';
import { PublicationStore } from '../src/publication.js';
import { SnapshotGate } from '../src/snapshotGate.js';
import { InvalidationCoordinator } from '../src/invalidation.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const timerTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

async function fixture(
  t: TestContext,
  render: () => Promise<string | void> = async () => {},
  project?: ConstructorParameters<typeof ResourcePublisher>[0]['publicResult'],
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-publisher-concurrency-'));
  const storage = new LocalStorage(root),
    store = new PublicationStore(storage, storage),
    gate = new SnapshotGate();
  const publisher = new ResourcePublisher({
    config: {
      resources: {
        roles: ['publish'],
        source: { consistency: 'snapshot', scope: 'test', revalidateMs: 5000 },
        cache: { metadataBytes: 8 * 1024 ** 2 },
        work: { maxTasks: 1, handoffMs: 30000 },
        publication: { debounceMs: 0, maxDelayMs: 1000, retainedMs: 604800000 },
        delivery: { mode: 'public', publicBaseUrl: 'https://fixture.invalid/' },
      },
      sourceIdentity: 'fixture',
    },
    store,
    sourceGate: gate,
    coordinator: new InvalidationCoordinator(),
    mounts: {},
    repository: undefined,
    target: {} as never,
    dynamic: { worldStore: { listWorlds: async () => [] }, assets: { textureIds: async () => [] } } as never,
    content: undefined,
    generator: { discard() {} } as never,
    sessions: { sourceScope: async () => 'test' } as never,
    rootEntries: () => [],
    renderRoot: async () => {
      const digest = await render();
      return { digest: typeof digest === 'string' ? digest : 'a'.repeat(64), entries: [] };
    },
    publicResult:
      project ??
      (async () => {
        throw new Error('background publication has no online result projection');
      }),
  });
  t.after(async () => {
    publisher.close();
    await publisher.drain();
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { publisher, store, gate };
}

test('automatic reconciliation waits for foreground preparation and still publishes the complete closure', async (t) => {
  const entered = deferred(),
    release = deferred();
  let first = true;
  const { publisher, store } = await fixture(t, async () => {
    if (first) {
      first = false;
      entered.resolve();
      await release.promise;
    }
  });
  const preparing = publisher.prepare();
  await entered.promise;
  publisher.schedule();
  await timerTurn();
  assert.equal(await store.publicationState(), null);
  release.resolve();
  await preparing;
  await publisher.drain();
  assert.ok(await store.head());
  assert.equal(publisher.state.publication, 'ready');
});

test('shutdown during online link projection cannot report a newly ready task', async (t) => {
  const entered = deferred(),
    release = deferred();
  const { publisher, store } = await fixture(t, undefined, async () => {
    entered.resolve();
    await release.promise;
    return {
      head: { mode: 'public', publicationId: (await store.head())!.publicationId } as never,
      resources: [],
    };
  });
  publisher.start(null);
  await entered.promise;
  publisher.close();
  release.resolve();
  await publisher.drain();
  assert.ok(await store.head(), 'the completed conditional commit remains authoritative');
  assert.equal(publisher.taskStatus()?.state, 'failed');
  assert.equal(publisher.taskStatus()?.result, undefined);
});

test('an already canceled reviewed publication performs no new source preparation', async (t) => {
  let renders = 0;
  const { publisher, store } = await fixture(t, async () => {
    renders++;
  });
  const prepared = await publisher.prepare();
  const controller = new AbortController();
  controller.abort(new Error('canceled before preparation'));
  await assert.rejects(publisher.publish(null, prepared, controller.signal), /canceled before preparation/);
  assert.equal(renders, 1);
  assert.equal(await store.head(), null);
});

test('a completed stable readiness intent does not suppress a later source publication with the same parent', async (t) => {
  let digest = 'a'.repeat(64);
  const { publisher, store } = await fixture(
    t,
    async () => digest,
    async () => ({
      head: { mode: 'public', publicationId: (await store.head())!.publicationId } as never,
      resources: [],
    }),
  );
  const original = await publisher.publish(null);
  const stable = publisher.start(original.publicationId);
  await publisher.drain();
  assert.equal(publisher.taskStatus(stable.id)?.state, 'ready');
  assert.equal((await store.head())?.publicationId, original.publicationId);
  digest = 'b'.repeat(64);
  const changed = publisher.start(original.publicationId);
  assert.notEqual(changed.id, stable.id);
  await publisher.drain();
  const ready = publisher.taskStatus(changed.id)!;
  assert.equal(ready.state, 'ready');
  assert.ok(ready.result && ready.result.head.mode === 'public');
  assert.notEqual(ready.result.head.publicationId, original.publicationId);
  assert.equal(ready.result.head.publicationId, (await store.head())?.publicationId);
});

test('an automatic publisher queued before a source mutation rechecks the durable snapshot requirement on admission', async (t) => {
  let rendered = false;
  const { publisher, gate, store } = await fixture(t, async () => {
    rendered = true;
  });
  const release = deferred();
  const mutation = gate.write(async () => {
    await release.promise;
    publisher.state.requiresSourceSnapshot = true;
    publisher.state.publication = 'pending';
    await store.pending('pending', undefined, true);
  });
  publisher.schedule();
  await timerTurn();
  release.resolve();
  await mutation;
  await publisher.drain();
  assert.equal(rendered, false);
  assert.equal(await store.head(), null);
  assert.equal(publisher.state.publication, 'pending');
  assert.equal((await store.publicationState())?.requiresSourceSnapshot, true);
});

test('failed background status is serialized before a following source snapshot marker', async (t) => {
  const { publisher, store, gate } = await fixture(t, async () => {
    throw new Error('injected build failure');
  });
  const pending = store.pending.bind(store),
    failed = deferred(),
    release = deferred();
  t.mock.method(store, 'pending', async (...args: Parameters<typeof pending>) => {
    if (args[0] === 'failed') {
      failed.resolve();
      await release.promise;
    }
    return pending(...args);
  });
  publisher.schedule();
  await failed.promise;
  let entered = false;
  const mutation = gate.write(async () => {
    entered = true;
    publisher.state.requiresSourceSnapshot = true;
    publisher.state.publication = 'pending';
    await store.pending('pending', undefined, true);
  });
  await timerTurn();
  assert.equal(entered, false);
  release.resolve();
  await mutation;
  await publisher.drain();
  assert.equal((await store.publicationState())?.requiresSourceSnapshot, true);
  assert.equal(publisher.state.publication, 'pending');
});
