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
        nbtHash: 'nbt',
        pendingFullVersion: -1,
        pendingLodVersion: -1,
      };
      let resolve!: (value: { kind: string; version: number }) => void;
      const started = new Promise<{ kind: string; version: number }>((done) => {
        resolve = done;
      });
      const manager = Object.assign(Object.create(ChunkManager.prototype), {
        chunks: new Map([[entry.key, entry]]),
        activeMeshTasks: 0,
        versionCounter: 0,
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
      assert.equal(kind === 'full' ? manager.requestFull(entry) : manager.requestLod(entry, 2), true);
      const worker = await Promise.race([
        started,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('cache failure stalled meshing')), 1000);
          timer.unref();
        }),
      ]);
      assert.deepEqual(worker, { kind, version: 1 });
      assert.equal(manager.activeMeshTasks, 1, 'the reserved task slot passes to the worker');
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
