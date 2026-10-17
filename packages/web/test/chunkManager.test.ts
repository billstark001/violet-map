import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChunkManager } from '../src/render/chunkManager.js';

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
