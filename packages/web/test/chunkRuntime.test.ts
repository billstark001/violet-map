import { planFixtureDemands } from './helpers/scheduling.js';
import { ChunkScheduler } from '../src/scheduling/chunkScheduler.js';
import { LoadingMetrics } from '../src/diagnostics/loadingMetrics.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { resourceClient } from '../src/resources/client.js';
import { ChunkRuntime } from '../src/runtime/chunkRuntime.js';
import { encode } from '@msgpack/msgpack';
import { chunkKey } from '../src/worker/protocol.js';

// Drive a mesh request through the real cache/error path, with only the worker
// boundary replaced. No browser globals or WebGL context are needed.
test('unavailable IndexedDB falls back to worker meshing for both full and LOD terrain', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
  try {
    for (const kind of ['full', 'lod'] as const) {
      const entry = {
        key: 'test',
        state: 'stored',
        dirtyToken: 0,
        contentDigest: 'nbt',
        pendingFullVersion: -1,
        pendingLodVersion: -1,
      };
      let resolve!: (value: { kind: string; version: number }) => void;
      const started = new Promise<{ kind: string; version: number }>((done) => {
        resolve = done;
      });
      const manager = Object.assign(Object.create(ChunkRuntime.prototype), {
        metrics: new LoadingMetrics(),
        chunks: new Map([[entry.key, entry]]),
        meshJobs: new Map(),
        activeMeshTasks: 0,
        versionCounter: 0,
        workers: [{}],
        fullCacheMisses: 0,
        lodCacheMisses: 0,
        disposed: false,
        maxActiveMeshTasks: () => 1,
        ensureNeighborhoodWorkerData: () => true,

        neighborhoodCacheParts: () => ({
          stable: true,
          parts: {
            world: 'test',
            dimension: 'minecraft:overworld',
            renderKey: 'test',
            cx: 0,
            cz: 0,
            contentKey: 'nbt',
          },
        }),
        flushMeshQueue() {
          const [version, job] = [...this.meshJobs][0];
          assert.equal(job.phase, 'waiting-input', 'cache miss waits for scheduler dispatch');
          resolve({ kind: job.kind, version });
        },
      });
      assert.equal(manager.requestMesh(entry, kind, kind === 'full' ? 1 : 2), true);
      const worker = await Promise.race([
        started,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('cache failure stalled meshing')), 1000);
          timer.unref();
        }),
      ]);
      assert.deepEqual(worker, { kind, version: 1 });
      assert.equal(manager.activeMeshTasks, 0, 'cache lookup never reserves a worker execution slot');
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, 'indexedDB', previous);
    else delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  }
});

test('disposing a manager cancels pending IO and ignores even an unabortable late response', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  for (const kind of ['hash', 'chunk'] as const) {
    for (const abortable of [true, false]) {
      let calls = 0;
      let signal!: AbortSignal;
      let finish!: (response: Response) => void;
      globalThis.fetch = (_input, init) => {
        calls++;
        signal = init!.signal!;
        return new Promise((resolve, reject) => {
          finish = resolve;
          if (abortable)
            signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
        });
      };
      const entry = { key: 'test', state: kind === 'hash' ? 'checking' : 'hashed', cx: 0, cz: 0 };
      const manager = Object.assign(Object.create(ChunkRuntime.prototype), {
        metrics: new LoadingMetrics(),
        opts: { world: 'test', dimension: 'minecraft:overworld' },
        requests: new AbortController(),
        disposed: false,
        coverageSeq: 0,
        chunks: new Map([[entry.key, entry]]),
        checking: 0,
        fetching: 0,

        markUnavailable: () => {
          throw new Error('late IO mutated a disposed chunk');
        },
        reportStats: () => {
          throw new Error('late IO reported stats');
        },

        scheduler: { clear() {} },
        terrain: { dispose() {} },

        hashTimer: null,
        fetchTimer: null,
        deferredMeshTimers: new Map(),
        meshJobs: new Map(),
        inFlightMeshVersions: new Set(),
        versionWorker: new Map(),

        workers: [],
        workerLoads: [],
      });
      const request = kind === 'hash' ? manager.fetchHashBatch([entry.key]) : manager.fetchBatch([entry.key]);
      await (kind === 'hash' ? manager.fetchHashBatch([entry.key]) : manager.fetchBatch([entry.key]));
      assert.equal(calls, 1, 'an in-flight entry cannot start a duplicate request');
      manager.dispose();
      manager.dispose();
      assert.equal(signal.aborted, true);
      if (!abortable) finish(new Response(encode({ chunks: [{ cx: 0, cz: 0, missing: true }] })));
      await request;
      assert.equal(manager.chunks.size, 0);
      assert.equal(manager.checking, 0);
      assert.equal(manager.fetching, 0);
      assert.equal(manager.hashTimer, null);
      assert.equal(manager.fetchTimer, null);
    }
  }
});

test('reloaded identical columns do not invalidate neighbors, and stale worker replies cannot change readiness', () => {
  const key = (cx: number) => chunkKey('world', 'minecraft:overworld', cx, 0);
  const center = {
    key: key(0),
    cx: 0,
    cz: 0,
    state: 'decoding',
    contentDigest: 'same',
    workerReadyMask: 0,
    estimatedColumnBytes: 0,
  };
  const neighbor = {
    key: key(1),
    cx: 1,
    cz: 0,
    displayed: 'full',
    state: 'stored',
    dirty: false,
    dirtyToken: 0,
    lastTier: 6,
    lastScore: 0,
  };
  const manager = Object.assign(Object.create(ChunkRuntime.prototype), {
    metrics: new LoadingMetrics(),
    opts: { world: 'world', dimension: 'minecraft:overworld' },
    chunks: new Map([
      [center.key, center],
      [neighbor.key, neighbor],
    ]),
    workers: [{}, {}],
    terrain: { updateSurface() {} },
    scheduler: { notify() {} },
    flushMeshQueue() {},
    reportStats() {},
  });
  const ready = (contentDigest: string, index: number) =>
    manager.handleMessage(
      { type: 'chunkReady', key: center.key, contentDigest, surfaceY: 64, biome: 'minecraft:plains' },
      index,
    );
  ready('same', 0);
  ready('same', 1);
  assert.equal(neighbor.dirtyToken, 1);
  center.state = 'decoding';
  center.workerReadyMask = 0;
  neighbor.dirty = false;
  ready('same', 0);
  ready('same', 1);
  assert.equal(neighbor.dirtyToken, 1, 're-residency alone is not a content change');
  center.state = 'decoding';
  center.workerReadyMask = 0;
  center.contentDigest = 'changed';
  ready('same', 0);
  assert.equal(center.workerReadyMask, 0);
  ready('changed', 0);
  ready('changed', 1);
  assert.equal(neighbor.dirtyToken, 2);
});

test('active neighborhood pins prevent eviction and settle exactly once', async () => {
  const dependency = {
    key: 'dependency',
    state: 'stored',
    contentDigest: 'same',
    workerKeepUntil: 0,
    workerPins: 1,
    workerReadyMask: 1,
  };
  const drops: unknown[] = [];
  const manager = Object.assign(Object.create(ChunkRuntime.prototype), {
    metrics: new LoadingMetrics(),
    meshJobs: new Map([[1, { dependencies: [dependency] }]]),
    inFlightMeshVersions: new Set([1]),
    versionWorker: new Map([[1, 0]]),
    activeMeshTasks: 1,
    workerLoads: [1],
    meshFlushScheduled: false,
    disposed: false,
    broadcast(message: unknown) {
      drops.push(message);
    },
    flushMeshQueue() {},
  });
  assert.equal(manager.releaseWorkerData(dependency), false);
  manager.finishActiveMesh(1);
  manager.finishActiveMesh(1);
  await Promise.resolve();
  assert.equal(dependency.workerPins, 0);
  assert.equal(manager.activeMeshTasks, 0);
  assert.deepEqual(manager.workerLoads, [0]);
  assert.equal(manager.releaseWorkerData(dependency), true);
  assert.equal(dependency.state, 'hashed');
  assert.equal(drops.length, 1);
});

test('a known neighborhood hits cached geometry before restoring any worker columns', async () => {
  await import('fake-indexeddb/auto');
  const { putCachedMesh, clearMeshCache, setMeshCacheEnabled } = await import('../src/resources/meshCache.js');
  setMeshCacheEnabled(true);
  await clearMeshCache();
  const entries = Array.from({ length: 9 }, (_, i) => {
    const cx = (i % 3) - 1,
      cz = Math.floor(i / 3) - 1;
    return {
      key: chunkKey('world', 'minecraft:overworld', cx, cz),
      cx,
      cz,
      state: 'hashed',
      contentDigest: 'unchanged',
      pendingFull: false,
      pendingLod: false,
      dirtyToken: 0,
      dirty: true,
    };
  });
  const center = entries[4];
  let displays = 0;
  const manager = Object.assign(Object.create(ChunkRuntime.prototype), {
    metrics: new LoadingMetrics(),
    chunks: new Map(entries.map((e) => [e.key, e])),
    opts: { sourceScope: 'scope', world: 'world', dimension: 'minecraft:overworld', renderKey: 'r' },
    workers: [{}],
    meshJobs: new Map(),
    versionCounter: 0,
    inFlightMeshVersions: new Set(),
    versionWorker: new Map(),
    activeMeshTasks: 0,
    fullCacheHits: 0,
    disposed: false,
    scheduler: { shouldAcceptMeshResult: () => true },
    flushMeshQueue() {},
    ensureNeighborhoodWorkerData() {
      throw Error('cached geometry must not require resident NBT');
    },
    applyMesh() {
      displays++;
    },
  });
  const cache = manager.neighborhoodCacheParts(center);
  assert.equal(cache.stable, true, 'digests stay known when columns are evicted');
  await putCachedMesh({ ...cache.parts, mode: 'full', step: 0 }, { mode: 'full', sections: [] });
  assert.equal(manager.requestMesh(center, 'full', 1), true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(displays, 1);
  assert.equal(manager.meshJobs.size, 0);
  assert.equal(manager.activeMeshTasks, 0);
  await clearMeshCache();
});

test('transient IO backs off without discarding displayed terrain; a worker deadline initiates recovery', async () => {
  const { ResourceError } = await import('@violet-map/core/resources');
  const entry = { key: 'chunk', contentDigest: 'known', retryAttempts: 0, state: 'fetching', displayed: 'full' };
  let queued = 0;
  const manager = Object.assign(Object.create(ChunkRuntime.prototype), {
    metrics: new LoadingMetrics(),
    activity: { retries: 0 },
    queueIo(kind: string) {
      assert.equal(kind, 'fetch');
      queued++;
    },
    meshJobs: new Map(),
    chunks: new Map(),
    disposed: false,
    recoverWorkers() {
      queued++;
    },
  });
  manager.retryIo(entry, new ResourceError('RESOURCE_BUSY', 'busy', true));
  assert.equal(entry.state, 'hashed');
  assert.equal(entry.displayed, 'full');
  assert.equal(entry.retryAttempts, 1);
  assert.equal(queued, 1);
  manager.meshJobs.set(1, { phase: 'worker', startedAt: performance.now() - 30001 });
  manager.checkWorkerHealth();
  assert.equal(queued, 2);
});

test('known neighbors are restored before first display and cancelled read admission remains retryable', () => {
  const center = {
    key: chunkKey('world', 'minecraft:overworld', 0, 0),
    cx: 0,
    cz: 0,
    state: 'stored',
    lastScore: 0,
    lastTier: 0,
  };
  const neighbor = {
    ...center,
    key: chunkKey('world', 'minecraft:overworld', 1, 0),
    cx: 1,
    state: 'hashed',
    displayed: 'none',
    contentDigest: 'known',
    workerKeepUntil: 0,
  };
  const queued: string[] = [];
  const manager = Object.assign(Object.create(ChunkRuntime.prototype), {
    metrics: new LoadingMetrics(),
    opts: { world: 'world', dimension: 'minecraft:overworld' },
    chunks: new Map([
      [center.key, center],
      [neighbor.key, neighbor],
    ]),
    scheduler: {
      notify(event: { type: string; key: string }) {
        if (event.type === 'fetchNeeded') queued.push(event.key);
      },
    },
    scheduleIoFlush() {},
  });
  assert.equal(manager.ensureNeighborhoodWorkerData(center, performance.now()), false);
  assert.deepEqual(queued, [neighbor.key]);
  // Admission may disappear when the camera changes before a body request
  // starts. The next mesh attempt must be able to request its dependency again.
  queued.length = 0;
  assert.equal(manager.ensureNeighborhoodWorkerData(center, performance.now()), false);
  assert.deepEqual(queued, [neighbor.key]);
  assert.equal(neighbor.state, 'hashed');
});

test('a body arriving during a Worker restart stays queued for an actual decode', () => {
  const key = chunkKey('world', 'minecraft:overworld', 0, 0);
  const entry = { key, cx: 0, cz: 0, state: 'fetching', contentDigest: 'digest' };
  let queued = 0,
    restarts = 0;
  const manager = Object.assign(Object.create(ChunkRuntime.prototype), {
    opts: { world: 'world', dimension: 'minecraft:overworld', dimensionDef: {} },
    chunks: new Map([[key, entry]]),
    workers: [],
    chunkBytesDecoded: 0,
    activity: { chunkDispatches: 0 },
    queueIo(kind: string, requestKey: string) {
      assert.equal(kind, 'fetch');
      assert.equal(requestKey, key);
      queued++;
    },
    recoverWorkers() {
      restarts++;
      entry.state = 'hashed';
    },
  });
  const payload = { cx: 0, cz: 0, contentDigest: 'digest', data: new Uint8Array([1]) };
  manager.handleFetchedChunk(payload);
  assert.equal(entry.state, 'hashed');
  assert.equal(manager.activity.chunkDispatches, 0);
  assert.equal(queued, 1);
  manager.workers = [
    {
      postMessage() {
        throw Error('worker terminated during transfer');
      },
    },
  ];
  entry.state = 'fetching';
  manager.handleFetchedChunk(payload);
  assert.equal(restarts, 1);
  assert.equal(entry.state, 'hashed');
  assert.equal(queued, 2);
});

test('new work preempts a later retry timer without retaining a duplicate wake', async (t) => {
  let flushes = 0;
  const manager = Object.assign(Object.create(ChunkRuntime.prototype), {
    disposed: false,
    hashTimer: null,
    fetchTimer: null,
    ioWakeAt: { hash: Infinity, fetch: Infinity },
    flushIoQueue() {
      flushes++;
    },
  });
  t.after(() => {
    if (manager.hashTimer) clearTimeout(manager.hashTimer);
  });
  manager.scheduleIoFlush('hash', 5000);
  const old = manager.hashTimer;
  manager.scheduleIoFlush('hash', 0);
  assert.notEqual(manager.hashTimer, old);
  await new Promise<void>((done) => setTimeout(done, 30));
  assert.equal(flushes, 1);
  assert.equal(manager.hashTimer, null);
});

test('repair promotes work priority while preserving the current LOD target', () => {
  const entry = {
    key: 'chunk',
    cx: 0,
    cz: 0,
    state: 'stored' as const,
    displayed: 'full' as const,
    displayedVersion: -1,
    displayedLodStep: 0,
    pendingLodStep: 0,
    dirty: false,
    dirtyToken: 0,
    pendingFull: false,
    pendingLod: false,
  };
  const scheduler = new ChunkScheduler();
  planFixtureDemands(
    scheduler,
    new Map([[entry.key, entry]]),
    performance.now(),
    () => 4,
    () => ({ tier: 3, score: 100 }),
  );
  const manager = Object.assign(Object.create(ChunkRuntime.prototype), { scheduler });
  manager.markDirty(entry);
  assert.equal(scheduler.demandFor(entry.key)!.targetStep, 4);
  assert.equal(entry.dirtyToken, 1);
  assert.ok(scheduler.demandFor(entry.key)!.boost!.tier <= 0);
  assert.equal('lastTargetStep' in entry, false, 'the executor never mirrors camera demand');
});

test('a recovered resolve or explicit absence clears obsolete retry state even without a body download', () => {
  const key = chunkKey('world', 'minecraft:overworld', 0, 0);
  const entry = {
    key,
    cx: 0,
    cz: 0,
    state: 'resolving',
    contentDigest: 'digest',
    retryAt: 5000,
    retryAttempts: 1,
    lastError: 'temporary outage',
  };
  const manager = Object.assign(Object.create(ChunkRuntime.prototype), {
    opts: { world: 'world', dimension: 'minecraft:overworld', renderRoot: 'root' },
    chunks: new Map([[key, entry]]),
  });
  const resolution = { head: { renderRoot: 'root' }, cx: 0, cz: 0, contentDigest: 'digest' };
  manager.handleFetchedResolution(resolution);
  assert.equal(entry.state, 'hashed');
  assert.equal(entry.retryAttempts, 0, 'a later geometry cache hit must not remain falsely retrying');
  assert.equal(entry.lastError, undefined);
  entry.state = 'fetching';
  entry.retryAttempts = 2;
  manager.handleFetchedResolution(resolution);
  assert.equal(entry.retryAttempts, 2, 'metadata renewal alone cannot reset a body failure streak');
  manager.markUnavailable(entry, 'absent', false, false);
  assert.equal(entry.retryAttempts, 0);
  assert.equal(entry.retryAt, 0);
});

test('resource refresh ignores replacement entries, newer IO and out-of-order refresh results', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const head = resourceClient.current('world') ?? {
    schemaVersion: 1,
    viewId: 'a'.repeat(64),
    mode: 'server',
    sourceScope: 'fixture',
    generation: 0,
    renderRoot: 'b'.repeat(64),
  };
  const pending: ((digest?: string) => void)[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).includes('/views/current')) return Response.json(head);
    assert.ok(String(input).endsWith('/resolve'));
    const request = JSON.parse(init!.body as string);
    return new Promise<Response>((resolve) =>
      pending.push((digest) =>
        resolve(
          Response.json({
            viewId: head.viewId,
            validUntil: Date.now() + 30000,
            resources: request.selectors.map((selector: unknown) =>
              digest
                ? {
                    selector,
                    contentDigest: digest,
                    terrainDigest: digest,
                    resource: {
                      schemaVersion: 1,
                      kind: 'chunk',
                      artifact: { digest, bytes: 1, mediaType: 'application/msgpack', format: 'chunk-msgpack-v1' },
                      url: 'https://resources.example/chunk',
                    },
                  }
                : { selector, missing: true },
            ),
          }),
        ),
      ),
    );
  };
  const fixture = () => {
    const entry = {
      key: chunkKey('refresh-races', 'minecraft:overworld', 0, 0),
      cx: 0,
      cz: 0,
      contentDigest: 'c'.repeat(64),
      resolution: {},
      ioRequest: Symbol('body'),
      state: 'fetching',
      retryAt: 10000,
      retryAttempts: 3,
      lastError: 'temporary outage',
    };
    const queued: string[] = [];
    const manager = Object.assign(Object.create(ChunkRuntime.prototype), {
      refreshSeq: 0,
      disposed: false,
      requests: new AbortController(),
      opts: { world: 'refresh-races', dimension: 'minecraft:overworld', renderRoot: head.renderRoot },
      chunks: new Map([[entry.key, entry]]),
      resetAfterSourceChange() {},
      markUnavailable() {
        throw new Error('obsolete absence must not remove current terrain');
      },
      queueIo(kind: string) {
        queued.push(kind);
      },
      async loadChunkSourceCoverage() {},
    });
    return { entry, manager, queued };
  };
  for (const change of ['replacement', 'request', 'resolution']) {
    pending.length = 0;
    const { entry, manager, queued } = fixture();
    const refreshing = manager.refreshResources();
    await nextTurn();
    assert.equal(pending.length, 1);
    const replacement = { ...entry, contentDigest: 'e'.repeat(64) };
    if (change === 'replacement') manager.chunks.set(entry.key, replacement);
    if (change === 'request') entry.ioRequest = Symbol('new request');
    if (change === 'resolution') entry.resolution = { renewed: true };
    pending[0]();
    await refreshing;
    assert.equal(manager.chunks.get(entry.key).state, 'fetching');
    assert.deepEqual(queued, []);
    assert.equal(replacement.contentDigest, 'e'.repeat(64));
  }
  pending.length = 0;
  const { entry, manager, queued } = fixture();
  const older = manager.refreshResources();
  const newer = manager.refreshResources();
  await nextTurn();
  assert.equal(pending.length, 2);
  pending[1]('f'.repeat(64));
  await newer;
  assert.equal(entry.contentDigest, 'f'.repeat(64));
  assert.equal(entry.ioRequest, undefined, 'the old body loses its lease when a newer revision wins');
  assert.equal(entry.state, 'hashed');
  assert.equal(entry.retryAttempts, 0);
  assert.deepEqual(queued, ['fetch']);
  pending[0]();
  await older;
  assert.equal(entry.contentDigest, 'f'.repeat(64));
  assert.deepEqual(queued, ['fetch']);
});
