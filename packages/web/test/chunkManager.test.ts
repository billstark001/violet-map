import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChunkManager } from '../src/render/chunkManager.js';
import { encode } from '@msgpack/msgpack';

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
