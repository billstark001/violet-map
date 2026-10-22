import { canonicalJson, parseResourceRef, parseResourceViewHead, ResourceError } from '@violet-map/core/resources';
import { artifactRef, sha256 } from '@violet-map/storage';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  actionKey,
  BlobRepository,
  ByteBudget,
  HandoffStore,
  InvalidationCoordinator,
  MemoryActionIndex,
  ResourceCache,
  ResourceDelivery,
  Singleflight,
  RevisionMemo,
  type PreparedResource,
} from '../src/index.js';

const bytes = new TextEncoder().encode('deterministic payload');
const key = sha256('action');

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('a fast consumer cannot consume the producer pin before a signal-owning shared waiter acquires it', async (t) => {
  const f = fixture();
  t.after(() => f.repository.close());
  for (let round = 0; round < 40; round++) {
    const immediate = f.repository.ensure(f.action).then((lease) => lease.release());
    const delayed = f.repository.ensure(f.action, new AbortController().signal);
    const [, lease] = await Promise.all([immediate, delayed]);
    assert.deepEqual(f.repository.open(lease.artifact), bytes);
    lease.release();
    assert.equal(f.repository.handoff.budget.bytes, 0);
  }
});

test('shared tasks cancel owners independently, retain retiring slots and dispose abandoned results once', async () => {
  const tasks = new Singleflight(2);
  const first = new AbortController();
  const second = new AbortController();
  let complete!: (value: number) => void;
  let lifetime!: AbortSignal;
  let disposed = 0;
  const run = (signal: AbortSignal) =>
    tasks.run(
      'same',
      async (owned) => {
        lifetime = owned;
        return new Promise<number>((resolve) => {
          complete = resolve;
        });
      },
      signal,
      {
        release: () => {
          disposed++;
        },
      },
    );
  const a = run(first.signal),
    b = run(second.signal);
  await tick();
  first.abort(new Error('first owner left'));
  await assert.rejects(a, /first owner left/);
  assert.equal(lifetime.aborted, false);
  second.abort(new Error('last owner left'));
  await assert.rejects(b, /last owner left/);
  assert.equal(lifetime.aborted, true);
  assert.equal(tasks.size, 1);
  let replace!: (value: number) => void;
  const replacement = tasks.run(
    'same',
    async () =>
      new Promise<number>((resolve) => {
        replace = resolve;
      }),
  );
  await tick();
  complete(1);
  await tick();
  assert.equal(disposed, 1);
  assert.equal(tasks.size, 1);
  const joined = tasks.run('same', async () => {
    throw new Error('retired cleanup removed replacement');
  });
  replace(2);
  assert.deepEqual(await Promise.all([replacement, joined]), [2, 2]);
  await tasks.close();
});

test('dependency memo retains only reliable unchanged revisions within its byte budget', async () => {
  let current: string | undefined = 'one',
    loads = 0;
  const memo = new RevisionMemo(4096);
  const read = () =>
    memo.get(
      'region',
      async () => current,
      async () => String(++loads),
    );
  assert.equal(await read(), '1');
  assert.equal(await read(), '1');
  current = 'two';
  assert.equal(await read(), '2');
  current = undefined;
  assert.equal(await read(), '3');
  assert.equal(await read(), '4');
  current = 'three';
  await assert.rejects(
    memo.get(
      'changing',
      async () => current,
      async () => {
        current = 'four';
        return 'digest';
      },
    ),
    { code: 'SOURCE_SNAPSHOT_CHANGED' },
  );
  const zero = new RevisionMemo(0);
  await zero.get(
    'zero',
    async () => 'same',
    async () => String(++loads),
  );
  await zero.get(
    'zero',
    async () => 'same',
    async () => String(++loads),
  );
  assert.equal(loads, 6);
});

test('dependency validation is admitted before expensive revision probes', async () => {
  const memo = new RevisionMemo(4096);
  let finish!: () => void,
    probes = 0;
  const barrier = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const pending = Array.from({ length: 16 }, (_, i) =>
    memo.get(
      String(i),
      async () => {
        probes++;
        await barrier;
        return 'revision';
      },
      async () => 'digest',
    ),
  );
  await assert.rejects(
    memo.get(
      'overflow',
      async () => {
        probes++;
        return 'revision';
      },
      async () => 'digest',
    ),
    { code: 'RESOURCE_BUSY' },
  );
  assert.equal(probes, 16);
  finish();
  await Promise.all(pending);
  assert.equal(
    await memo.get(
      'next',
      async () => 'revision',
      async () => 'next digest',
    ),
    'next digest',
  );
});

test('a canceled logical owner cannot release a shared action reservation still used by another owner', async (t) => {
  const f = fixture();
  t.after(() => f.repository.close());
  let finish!: () => void;
  let actionSignal!: AbortSignal;
  const action = {
    ...f.action,
    generate: async (signal: AbortSignal) => {
      actionSignal = signal;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return bytes;
    },
  };
  const controller = new AbortController();
  const a = f.repository.build('a', 0, action.maxBytes, action.workBytes, async () => action, 1, controller.signal);
  await tick();
  // An ensure waiter borrows the materializer without owning a second
  // preparation reservation that could mask premature release of the first.
  const b = f.repository.ensure(action);
  await tick();
  controller.abort(new Error('owner left'));
  await assert.rejects(a, /owner left/);
  await tick();
  assert.equal(actionSignal.aborted, false);
  assert.ok(f.repository.work.bytes >= action.workBytes);
  finish();
  const lease = await b;
  assert.ok(lease);
  lease.release();
  assert.equal(f.repository.work.bytes, 0);
  assert.equal(f.repository.handoff.budget.bytes, 0);
});

test('handoff renewal extends the final delivery window without creating another claim', () => {
  let now = 100;
  const handoff = new HandoffStore(1024, 30, () => now);
  handoff.put('object', bytes);
  handoff.claim('object');
  now = 120;
  assert.equal(handoff.renew('object'), 150);
  handoff.consume('object');
  assert.equal(handoff.budget.bytes, 0);
  handoff.put('expired', bytes);
  now = 151;
  assert.throws(() => handoff.renew('expired'), { code: 'RESOURCE_VIEW_EXPIRED' });
  handoff.close();
});

test('a canceled publisher body read leaves its queued work budget and promise owned by the remaining consumer', async (t) => {
  const f = fixture();
  t.after(() => f.repository.close());
  const held = await f.repository.ensure(f.action);
  const occupy = f.repository.work.reserve(f.repository.work.capacity);
  const controller = new AbortController();
  const reading = f.repository.acquire(held.artifact, false, controller.signal);
  await tick();
  assert.equal(f.repository.work.queuedTasks, 1);
  controller.abort(new Error('publisher stopped'));
  await assert.rejects(reading, /publisher stopped/);
  assert.equal(f.repository.work.queuedTasks, 0);
  occupy();
  assert.ok(f.repository.lease(held.artifact));
  held.release();
  assert.equal(f.repository.handoff.budget.bytes, 0);
});

function fixture(memoryBytes = 0, handoffBytes = 1024) {
  const source = new InvalidationCoordinator();
  const index = new MemoryActionIndex(4096);
  const repository = new BlobRepository({
    memoryBytes,
    workBytes: 2048,
    handoffBytes,
    handoffMs: 30_000,
    maxTasks: 8,
    index,
    source,
  });
  let generated = 0;
  const action: PreparedResource = {
    actionKey: key,
    generation: 0,
    mediaType: 'application/msgpack',
    format: 'chunk-msgpack-v1',
    maxBytes: 256,
    workBytes: 512,
    async generate() {
      generated++;
      return bytes;
    },
  };
  return {
    source,
    index,
    repository,
    action,
    get generated() {
      return generated;
    },
  };
}

test('canonical keys reject ambiguous input and ignore JSON object insertion order', () => {
  assert.equal(canonicalJson({ z: [1, null], a: 'x' }), canonicalJson({ a: 'x', z: [1, null] }));
  for (const value of [
    undefined,
    NaN,
    Infinity,
    new Date(),
    {
      get dynamic() {
        return 1;
      },
    },
    Object.assign([], { extra: 1 }),
    [undefined],
    new Array(1),
    { a: undefined },
    { [Symbol('x')]: 1 },
  ])
    assert.throws(() => canonicalJson(value));
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic));
  const input = {
    generator: 'chunk',
    version: 1,
    format: 'chunk-msgpack-v1',
    params: { cx: -32, cz: 1 },
    dependencies: [
      { role: 'terrain', digest: sha256('t') },
      { role: 'entities', digest: sha256('e') },
    ],
  };
  assert.equal(actionKey(input), actionKey({ ...input, dependencies: [...input.dependencies].reverse() }));
  assert.notEqual(actionKey(input), actionKey({ ...input, version: 2 }));
  assert.throws(() => actionKey({ ...input, dependencies: [input.dependencies[0], input.dependencies[0]] }));
});

test('strict references and mode-discriminated views accept only the current contract', () => {
  const artifact = artifactRef(bytes, 'application/msgpack', 'chunk-msgpack-v1');
  const ref = { schemaVersion: 1, kind: 'chunk', artifact, url: 'https://resources.example/objects/a' };
  assert.deepEqual(parseResourceRef(ref), ref);
  for (const invalid of [
    { ...ref, publicUrl: ref.url },
    { ...ref, schemaVersion: 0 },
    { ...ref, kind: 'unknown' },
    { ...ref, url: 'https://user:secret@example/a' },
    { ...ref, artifact: { ...artifact, bytes: -1 } },
  ])
    assert.throws(() => parseResourceRef(invalid));
  const view = {
    schemaVersion: 1,
    mode: 'server',
    viewId: 'one',
    sourceScope: 'archive:one',
    generation: 0,
    renderRoot: key,
  };
  assert.deepEqual(parseResourceViewHead(view), view);
  assert.throws(() => parseResourceViewHead({ ...view, publicationId: key }));
  assert.throws(() => parseResourceViewHead({ ...view, mode: 'public' }));
});

test('zero retention coalesces 100 resolves and delivers the same verified bytes', async (t) => {
  const f = fixture();
  t.after(() => f.repository.close());
  const leases = await Promise.all(Array.from({ length: 100 }, () => f.repository.ensure(f.action)));
  assert.equal(f.generated, 1);
  assert.equal(f.repository.tasks.coalesced, 99);
  assert.equal(f.repository.cache.bytes, 0);
  assert.equal(f.repository.work.bytes, 0);
  assert.equal(f.repository.handoff.budget.bytes, bytes.byteLength);
  assert.deepEqual(f.repository.open(leases[0].artifact), bytes);
  f.repository.handoff.release(leases[0].artifact.digest);
  assert.equal(f.repository.handoff.budget.bytes, 0);
  assert.throws(() => f.repository.open(leases[0].artifact), { code: 'RESOURCE_VIEW_EXPIRED' });
  await f.repository.ensure(f.action);
  assert.equal(f.generated, 2);
});

test('handoff exhaustion rejects before generation; idle pins expire without another request', async (t) => {
  const f = fixture(0, 128);
  t.after(() => f.repository.close());
  await assert.rejects(f.repository.ensure(f.action), { code: 'RESOURCE_BUSY' });
  assert.equal(f.generated, 0);
  assert.equal(f.repository.work.bytes, 0);
  const store = new HandoffStore(1024, 5);
  t.after(() => store.close());
  store.put(key, bytes);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.budget.bytes, 0);
  assert.equal(store.expired, 1);
});

test('generation guard does not index or hand off stale work', async (t) => {
  const f = fixture();
  t.after(() => f.repository.close());
  await assert.rejects(
    f.repository.ensure({
      ...f.action,
      async generate() {
        f.source.invalidate();
        return bytes;
      },
    }),
    { code: 'SOURCE_SNAPSHOT_CHANGED' },
  );
  assert.equal(await f.index.get(key), undefined);
  assert.equal(f.repository.handoff.budget.bytes, 0);
  assert.equal(f.repository.work.bytes, 0);
});

test('regeneration must match the known action representation', async (t) => {
  const f = fixture();
  t.after(() => f.repository.close());
  const first = await f.repository.ensure(f.action);
  f.repository.handoff.release(first.artifact.digest);
  await assert.rejects(
    f.repository.ensure({
      ...f.action,
      async generate() {
        return new Uint8Array([0]);
      },
    }),
    { code: 'RESOURCE_INTEGRITY_FAILED' },
  );
  assert.equal(f.repository.handoff.budget.bytes, 0);
});

test('working set and output limits apply independently from optional retention', async (t) => {
  const f = fixture();
  t.after(() => f.repository.close());
  await assert.rejects(f.repository.ensure({ ...f.action, workBytes: 4096 }), { code: 'RESOURCE_BUSY' });
  assert.equal(f.generated, 0);
  await assert.rejects(f.repository.ensure({ ...f.action, maxBytes: 1 }), { code: 'RESOURCE_BUSY' });
  assert.equal(f.repository.work.bytes, 0);
  assert.equal(f.repository.handoff.budget.bytes, 0);
});

test('admission protects hot objects during oversized objects and scans; zero resize drops retention', () => {
  const cache = new ResourceCache<string>(10);
  cache.get('hot');
  cache.set('hot', 'hot', 10);
  for (let i = 0; i < 20; i++) assert.equal(cache.get('hot'), 'hot');
  assert.equal(cache.set('oversized', 'large', 11), false);
  assert.equal(cache.get('hot'), 'hot');
  for (let i = 0; i < 100; i++) {
    cache.get(`scan${i}`);
    cache.set(`scan${i}`, 'scan', 10);
    assert.ok(cache.bytes <= 10);
  }
  assert.equal(cache.get('hot'), 'hot');
  cache.resize(0);
  assert.equal(cache.bytes, 0);
  assert.equal(cache.size, 0);
  assert.equal(cache.set('empty', '', 0), false);
});

test('budget shrink reports draining and releases reservations once', () => {
  const budget = new ByteBudget(100);
  const release = budget.reserve(80);
  budget.resize(0);
  assert.equal(budget.draining, true);
  assert.throws(() => budget.reserve(1), ResourceError);
  release();
  release();
  assert.equal(budget.bytes, 0);
  assert.equal(budget.draining, false);
});

test('singleflight bounds distinct tasks and releases failures', async () => {
  const flight = new Singleflight(1);
  let finish!: () => void;
  const first = flight.run(
    'a',
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  await assert.rejects(
    flight.run('b', async () => 2),
    { code: 'RESOURCE_BUSY' },
  );
  finish();
  await first;
  await assert.rejects(
    flight.run('failure', async () => {
      throw new Error('backend failed');
    }),
    /backend failed/,
  );
  assert.equal(await flight.run('b', async () => 2), 2);
  assert.equal(flight.size, 0);
});

test('public domain changes affect projection without changing object identity', () => {
  const ref = artifactRef(bytes, 'application/msgpack', 'chunk-msgpack-v1');
  const first = new ResourceDelivery({ mode: 'public', publicBaseUrl: 'https://one.example/map/' });
  const second = new ResourceDelivery({ mode: 'public', publicBaseUrl: 'https://two.example/map/' });
  assert.throws(() => first.resolve('v', 'chunk', ref, false), { code: 'RESOURCE_NOT_PUBLISHED' });
  const a = first.resolve('v', 'chunk', ref, true);
  const b = second.resolve('v', 'chunk', ref, true);
  assert.equal(new URL(a.url).pathname, new URL(b.url).pathname);
  assert.deepEqual(a.artifact, b.artifact);
  assert.equal('publicUrl' in a, false);
});

test('shutdown aborts outstanding generation, drains reservations and refuses new work', async () => {
  const f = fixture();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = f.repository.ensure({
    ...f.action,
    async generate(signal) {
      started();
      return new Promise<Uint8Array>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    },
  });
  await ready;
  const closing = f.repository.close();
  await assert.rejects(pending, { code: 'RESOURCE_BUSY' });
  await closing;
  assert.equal(f.repository.work.bytes, 0);
  assert.equal(f.repository.handoff.budget.bytes, 0);
  assert.equal(await f.index.get(key), undefined);
  await assert.rejects(f.repository.ensure(f.action), { code: 'RESOURCE_BUSY' });
});

test('small and empty artifacts cannot create an unbounded metadata map', () => {
  const cache = new ResourceCache<number>(1024 * 1024, 8);
  for (let i = 0; i < 1000; i++) {
    cache.get(String(i));
    cache.set(String(i), i, 0);
    assert.ok(cache.size <= 8);
  }
  assert.throws(() => cache.set('x'.repeat(257), 0, 0), /metadata limits/);
  const disabledMetadata = new ResourceCache<number>(1024, 0);
  assert.equal(disabledMetadata.set('one', 1, 1), false);
});

test('publisher reads and preparation cleanup cannot consume viewer handoff promises', async (t) => {
  const f = fixture();
  t.after(() => f.repository.close());
  const { artifact } = await f.repository.ensure(f.action);
  f.repository.handoff.releaseUnclaimed(artifact.digest);
  const publishing = await f.repository.acquire(artifact, false);
  publishing.release();
  assert.ok(f.repository.lease(artifact));
  const downloading = await f.repository.acquire(artifact);
  assert.deepEqual(downloading.bytes, bytes);
  downloading.release();
  assert.equal(f.repository.lease(artifact), undefined);
  assert.equal(f.repository.work.bytes, 0);
});

test('shrink to zero keeps active transfers accounted while refusing new work until drain', async (t) => {
  const f = fixture(1024);
  t.after(() => f.repository.close());
  const { artifact } = await f.repository.ensure(f.action);
  const read = await f.repository.acquire(artifact);
  f.repository.cache.resize(0);
  f.repository.handoff.budget.resize(0);
  f.repository.work.resize(0);
  assert.equal(f.repository.cache.bytes, 0);
  assert.equal(f.repository.work.draining, true);
  assert.equal(f.repository.handoff.budget.draining, true);
  await assert.rejects(f.repository.ensure({ ...f.action, actionKey: sha256('new') }), { code: 'RESOURCE_BUSY' });
  assert.deepEqual(read.bytes, bytes);
  read.release();
  assert.equal(f.repository.work.bytes, 0);
  assert.equal(f.repository.handoff.budget.bytes, 0);
});

test('interleaved hot zero-retention resolves and GETs own their pins before another reader can consume them', async (t) => {
  const f = fixture();
  t.after(() => f.repository.close());
  for (let round = 0; round < 8; round++) {
    await Promise.all(
      Array.from({ length: 100 }, async (_, index) => {
        if (index % 3 === 0) await Promise.resolve();
        const lease = await f.repository.ensure(f.action);
        if (index % 2 === 0) await Promise.resolve();
        const read = await f.repository.acquire(lease.artifact);
        assert.deepEqual(read.bytes, bytes);
        read.release();
      }),
    );
    assert.equal(f.repository.handoff.budget.bytes, 0);
    assert.equal(f.repository.work.bytes, 0);
  }
});

test('generation waits in a bounded work queue before preparation and drains when a transfer releases memory', async (t) => {
  const f = fixture();
  t.after(() => f.repository.close());
  const release = f.repository.work.reserve(f.repository.work.capacity);
  let prepared = 0;
  const pending = f.repository.build('logical', 0, f.action.maxBytes, f.action.workBytes, async () => {
    prepared++;
    return f.action;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(prepared, 0);
  assert.equal(f.repository.work.queuedTasks, 1);
  assert.equal(f.repository.work.queuedBytes, f.action.workBytes);
  release();
  const lease = await pending;
  assert.ok(lease);
  assert.equal(prepared, 1);
  const read = await f.repository.acquire(lease.artifact);
  read.release();
  assert.equal(f.repository.work.queuedBytes, 0);
  assert.equal(f.repository.work.bytes, 0);
});

test('handoff admission leaves work bytes available for GETs that release earlier promises', async (t) => {
  const f = fixture(0, 1024);
  t.after(() => f.repository.close());
  const old = new Uint8Array(900),
    ref = artifactRef(old, 'application/msgpack', 'chunk-msgpack-v1');
  f.repository.handoff.put(ref.digest, old);
  const pending = f.repository.ensure(f.action);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.repository.handoff.budget.queuedTasks, 1);
  assert.equal(f.repository.work.bytes, 0);
  const read = await f.repository.acquire(ref);
  read.release();
  const lease = await pending;
  assert.ok(lease);
  lease.release();
  assert.equal(f.repository.handoff.budget.bytes, 0);
  assert.equal(f.repository.work.bytes, 0);
});

test('handoff reservations become actual pins before competing producers can take the released capacity', async (t) => {
  const f = fixture(0, 256);
  t.after(() => f.repository.close());
  const first = await f.repository.ensure(f.action);
  const make = (name: string) =>
    f.repository.ensure({
      ...f.action,
      actionKey: sha256(name),
      generate: async () => new TextEncoder().encode(name),
    });
  const second = make('second'),
    third = make('third');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.repository.handoff.budget.queuedTasks, 2);
  first.release();
  const held = await second;
  assert.equal(f.repository.handoff.budget.queuedTasks, 1);
  assert.equal(f.repository.work.bytes, 0);
  held.release();
  (await third).release();
  assert.equal(f.repository.handoff.budget.bytes, 0);
});

test('cold generated digests participate in low-benefit fill observation without retaining delivery pins', async (t) => {
  const f = fixture(1024);
  t.after(() => f.repository.close());
  for (let i = 0; i < 200; i++) {
    const lease = await f.repository.ensure({
      ...f.action,
      actionKey: sha256(String(i)),
      generate: async () => new TextEncoder().encode(String(i)),
    });
    const read = await f.repository.acquire(lease.artifact);
    read.release();
  }
  assert.ok(f.repository.cache.metrics.fillPaused > 0);
  assert.ok(f.repository.cache.metrics.fillPausedReject > 0);
  assert.equal(f.repository.handoff.budget.bytes, 0);
  assert.ok(f.repository.cache.bytes <= 1024);
});
