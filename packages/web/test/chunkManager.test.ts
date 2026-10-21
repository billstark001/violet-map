import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChunkManager } from '../src/render/chunkManager.js';
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
      const manager = Object.assign(Object.create(ChunkManager.prototype), {
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
        contentHash: () => 'nbt',
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
        startWorkerMeshing: (_entry: unknown, task: string, _step: number, version: number) =>
          resolve({ kind: task, version }),
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

test('section visibility revisits independent entrances and stops at a solid neighbor', () => {
  const mask = (pairs: number[][]) =>
    pairs.reduce((value, [from, to]) => value + 2 ** (from * 6 + to) + 2 ** (to * 6 + from), 0);
  const all = mask(
    Array.from({ length: 6 }, (_, from) =>
      Array.from({ length: 5 - from }, (_, offset) => [from, from + offset + 1]),
    ).flat(),
  );
  const sections = [
    [0, 0, mask([[2, 3]])],
    [1, 0, all],
    [
      2,
      0,
      mask([
        [4, 5],
        [2, 3],
      ]),
    ],
    [0, -1, all],
    [1, -1, all],
    [2, -1, all],
    [2, 1, all],
    [3, 0, 0],
    [4, 0, all],
  ].map(([cx, cz, visibility]) => ({
    key: `${cx},0,${cz}`,
    cx,
    sy: 0,
    cz,
    visibility,
    visible: true,
    meshes: [{ visible: true }],
  }));
  const manager = Object.assign(Object.create(ChunkManager.prototype), {
    opts: { world: 'test', dimension: 'minecraft:overworld' },
    fullSectionIndex: new Map(sections.map((section) => [section.key, section])),
    chunks: new Map([[chunkKey('test', 'minecraft:overworld', 0, 0), { surfaceY: 100 }]]),
    topDownView: false,
    visibilityRevision: 1,
    lastVisibilityRevision: -1,
    visibleSectionKeys: new Set(),
    visibilityEntryMasks: new Map(),
    visibilityQueueSections: [],
    visibilityQueueEntries: [],
    sectionVisibilityRevision: 0,
  });
  manager.updateFullSectionVisibility({ position: { x: 1, y: 1, z: 1 } });
  assert.equal(
    manager.fullSectionIndex.get('2,0,1').visible,
    true,
    'the north entrance must reveal the south corridor even after a west entry',
  );
  assert.equal(
    manager.fullSectionIndex.get('3,0,0').visible,
    true,
    'the visible face of a solid boundary still renders',
  );
  assert.equal(
    manager.fullSectionIndex.get('4,0,0').visible,
    false,
    'zero connectivity must stop traversal behind the boundary',
  );
});

test('disposing a manager cancels pending IO and ignores even an unabortable late response', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  for (const kind of ['hash', 'chunk'] as const) {
    for (const abortable of [true, false]) {
      let signal!: AbortSignal;
      let finish!: (response: Response) => void;
      globalThis.fetch = (_input, init) => {
        signal = init!.signal!;
        return new Promise((resolve, reject) => {
          finish = resolve;
          if (abortable)
            signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
        });
      };
      const entry = { key: 'test', state: kind === 'hash' ? 'checking' : 'hashed', cx: 0, cz: 0 };
      const manager = Object.assign(Object.create(ChunkManager.prototype), {
        opts: { world: 'test', dimension: 'minecraft:overworld' },
        requests: new AbortController(),
        disposed: false,
        coverageSeq: 0,
        chunks: new Map([[entry.key, entry]]),
        checking: 0,
        fetching: 0,
        beginActiveOperation: () => 0,
        finishActiveOperation: () => {},
        markUnavailable: () => {
          throw new Error('late IO mutated a disposed chunk');
        },
        reportStats: () => {
          throw new Error('late IO reported stats');
        },
        removeMesh: () => {},
        scheduler: { clear() {} },
        scene: { remove() {} },
        root: {},
        visibleSectionKeys: new Set(),
        visibilityEntryMasks: new Map(),
        visibilityQueueSections: [],
        visibilityQueueEntries: [],
        hashTimer: null,
        fetchTimer: null,
        deferredMeshTimers: new Map(),
        meshJobs: new Map(),
        inFlightMeshVersions: new Set(),
        versionWorker: new Map(),
        meshDiagnosticByVersion: new Map(),
        activeDiagnostics: new Map(),
        workers: [],
        workerLoads: [],
      });
      const request = kind === 'hash' ? manager.fetchHashBatch([entry.key]) : manager.fetchBatch([entry.key]);
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
  const manager = Object.assign(Object.create(ChunkManager.prototype), {
    opts: { world: 'world', dimension: 'minecraft:overworld' },
    chunks: new Map([
      [center.key, center],
      [neighbor.key, neighbor],
    ]),
    workers: [{}, {}],
    recordCompletedOperation() {},
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
  const manager = Object.assign(Object.create(ChunkManager.prototype), {
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
  const { putCachedMesh, clearMeshCache, setMeshCacheEnabled } = await import('../src/meshCache.js');
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
  const manager = Object.assign(Object.create(ChunkManager.prototype), {
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
    shouldApplyMeshResult: () => true,
    flushMeshQueue() {},
    ensureNeighborhoodWorkerData() {
      throw Error('cached geometry must not require resident NBT');
    },
    displayFull() {
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
  const manager = Object.assign(Object.create(ChunkManager.prototype), {
    activity: { retries: 0 },
    queueFetch() {
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
  const manager = Object.assign(Object.create(ChunkManager.prototype), {
    opts: { world: 'world', dimension: 'minecraft:overworld' },
    chunks: new Map([
      [center.key, center],
      [neighbor.key, neighbor],
    ]),
    scheduler: {
      notify(event: { key: string }) {
        queued.push(event.key);
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
