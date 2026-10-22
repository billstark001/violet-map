import { planFixtureDemands } from './helpers/scheduling.js';
import { captureView } from '../src/render/viewSnapshot.js';
import { UNCLIPPED_VIEW } from '../src/view/worldGeometry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { ChunkIoBatch } from '../src/runtime/chunkIo.js';
import { ChunkScheduler } from '../src/scheduling/chunkScheduler.js';
import { ChunkViewPlanner } from '../src/scheduling/chunkView.js';
import { resolveChunkScheduling, diskCellCount } from '../src/scheduling/chunkPolicy.js';
import { schedulerTuningForPreset } from '../src/scheduling/profiles.js';
import { LoadingMetrics } from '../src/diagnostics/loadingMetrics.js';
import type { ChunkSchedulerEntry, ChunkState } from '../src/scheduling/contracts.js';
import { testView } from './helpers/scheduling.js';

function entry(key: string, state: ChunkState = 'stored'): ChunkSchedulerEntry {
  return {
    key,
    cx: 0,
    cz: 0,
    state,
    workerPins: 0,
    pendingFull: false,
    pendingLod: false,
    pendingLodStep: 0,
    displayed: 'none',
    displayedLodStep: 0,
    displayedVersion: -1,
    dirty: false,
  };
}

test('IO leases distinguish replacement entries and overlapping request generations', () => {
  const original = entry('chunk', 'checking');
  const entries = new Map([[original.key, original]]);
  const old = new ChunkIoBatch([original], 'resolving');
  assert.equal(old.current(original.key, entries), original);
  const fresh = new ChunkIoBatch([original], 'resolving');
  old.release();
  assert.equal(fresh.current(original.key, entries), original, 'old cleanup cannot release the new request');
  entries.set(original.key, entry(original.key, 'resolving'));
  assert.equal(fresh.current(original.key, entries), undefined, 'old response cannot write a replacement entry');
  fresh.release();
});

test('capacity normalization reserves the promised disks even with conflicting custom limits', () => {
  const config = resolveChunkScheduling({ activeRadiusChunks: 8, fullDetailRadiusChunks: 32, maxTrackedChunks: 64 });
  assert.ok(config.activeRadiusChunks >= 32);
  assert.ok(config.maxTrackedChunks >= diskCellCount(32));
});

test('height slices demand full geometry and reject a ready surface task', () => {
  const scheduler = new ChunkScheduler();
  const chunk = { ...entry('0,0'), displayed: 'lod' as const, displayedLodStep: 2 };
  const entries = new Map([[chunk.key, chunk]]);
  scheduler.tick({
    view: { ...testView, mode: 'top', clip: { minY: 0, maxY: 48 } },
    now: 1000,
    options: { scheduling: { activeRadiusChunks: 8, fullDetailRadiusChunks: 1 } },
    keyFor: (cx, cz) => `${cx},${cz}`,
    entries,
    cellInfoFor: () => ({ hasChunkSource: true, topMapSurfaceY: 64 }),
  });
  assert.equal(scheduler.demandFor(chunk.key)?.targetStep, 1);
  assert.equal(scheduler.diagnosticSnapshot(1000, entries).lodDisabled, true);
  const work = scheduler.nextWork({
    now: 1000,
    entries,
    activeHashBatches: 0,
    activeFetchBatches: 0,
    activeMeshTasks: 0,
    maxMeshTasks: 1,
    includeHash: false,
    includeFetch: false,
  });
  assert.equal(work.meshTasks[0]?.kind, 'full');
  assert.equal(scheduler.shouldAcceptMeshResult({ entry: chunk, kind: 'lod', step: 2, version: 1, now: 1000 }), false);
});

test('queue and retention tuning preserve the camera attention history', () => {
  const view = new ChunkViewPlanner();
  const camera = new THREE.PerspectiveCamera(75, 1.44, 0.1, 10000);
  camera.position.set(0, 79, 0);
  camera.lookAt(0, 65, 100);
  const tuning = schedulerTuningForPreset('medium', 8, 12);
  const input = {
    view: captureView(camera, false, UNCLIPPED_VIEW),
    now: 1000,
    options: { scheduling: tuning },
    keyFor: (x: number, z: number) => `${x},${z}`,
    entries: new Map(),
    demands: new Map(),
    cellInfoFor: () => ({ hasChunkSource: true, topMapSurfaceY: 64 }),
  };
  view.plan(input);
  view.plan({ ...input, now: 2000 });
  const before = view.diagnosticCell(0, 5)!.importance;
  view.plan({
    ...input,
    now: 3000,
    options: { scheduling: { ...tuning, maxTrackedChunks: 640, maxCandidates: 1536 } },
  });
  assert.ok(before > 0.1);
  assert.ok(view.diagnosticCell(0, 5)!.importance >= before, 'admission tuning must not reseed attention');
});

test('invalidations and queued meshes obey the current quality target', () => {
  const scheduler = new ChunkScheduler();
  const chunk = { ...entry('chunk'), displayed: 'full' as const, dirty: true };
  planFixtureDemands(scheduler, new Map([[chunk.key, chunk]]), 100, () => 4);
  scheduler.notify({ type: 'meshInvalidated', entry: chunk, now: 100 });
  const input = {
    now: 100,
    activeHashBatches: 0,
    activeFetchBatches: 0,
    activeMeshTasks: 0,
    maxMeshTasks: 1,
    entries: new Map([[chunk.key, chunk]]),
    includeHash: false,
    includeFetch: false,
  };
  const task = scheduler.nextWork(input).meshTasks[0];
  assert.equal(task.kind, 'lod');
  assert.equal(task.step, 4, 'repair must not replace the camera demand with an old full mesh');
  assert.equal(scheduler.shouldAcceptMeshResult({ entry: chunk, kind: 'full', step: 1, version: 1, now: 100 }), false);
  const upgraded = new ChunkScheduler();
  const pending = { ...entry('chunk') };
  planFixtureDemands(upgraded, new Map([[pending.key, pending]]), 100, () => 2);
  assert.equal(upgraded.nextWork({ ...input, entries: new Map([[pending.key, pending]]) }).meshTasks[0].step, 2);
});

test('backpressure counts completed geometry independently of decoded-input residency', () => {
  const select = (completed: boolean) => {
    const scheduler = new ChunkScheduler();
    const ready = Array.from({ length: 300 }, (_, i) => ({
      ...entry(`ready${i}`, 'hashed'),
      displayed: completed ? ('full' as const) : ('none' as const),
    }));
    const resident = Array.from({ length: 12 }, (_, i) => ({
      ...entry(`resident${i}`),
      displayed: i < 6 ? ('full' as const) : ('none' as const),
    }));
    const pending = Array.from({ length: 20 }, (_, i) => entry(`hash${i}`, 'checking'));
    const entries = [...ready, ...resident, ...pending];
    const byKey = new Map(entries.map((chunk) => [chunk.key, chunk]));
    planFixtureDemands(scheduler, byKey, 100);
    for (const chunk of pending) scheduler.notify({ type: 'hashNeeded', key: chunk.key });
    return scheduler.nextWork({
      now: 100,
      activeHashBatches: 0,
      activeFetchBatches: 0,
      activeMeshTasks: 2,
      maxMeshTasks: 2,
      entries: byKey,
      includeFetch: false,
      includeMesh: false,
    }).hashBatches[0].length;
  };
  assert.equal(select(true), 16, 'completed empty/cached terrain is ready even with no decoded columns');
  assert.equal(select(false), 4, 'unfinished terrain still applies render backpressure');
});

test('in-flight reads cannot be selected as queued work', () => {
  for (const state of ['resolving', 'fetching'] as const) {
    const scheduler = new ChunkScheduler();
    const chunk = entry('chunk', state);
    planFixtureDemands(scheduler, new Map([[chunk.key, chunk]]), 100);
    scheduler.notify({ type: state === 'resolving' ? 'hashNeeded' : 'fetchNeeded', key: chunk.key });
    const work = scheduler.nextWork({
      now: 100,
      activeHashBatches: 0,
      activeFetchBatches: 0,
      activeMeshTasks: 0,
      maxMeshTasks: 1,
      entries: new Map([[chunk.key, chunk]]),
    });
    assert.deepEqual(work.hashBatches, []);
    assert.deepEqual(work.fetchBatches, []);
  }
});

test('delayed diagnostics settle once without becoming a second task lifecycle', () => {
  const metrics = new LoadingMetrics();
  for (let i = 0; i < 8; i++) metrics.record('fullMesh', 100, 'baseline');
  const token = metrics.begin('fullMesh', 'delayed');
  metrics.checkDelayed(performance.now() + 3000);
  metrics.finish(token, 3000);
  const once = metrics.snapshot();
  metrics.finish(token, 3000);
  assert.deepEqual(metrics.snapshot(), once);
  assert.equal(once.diagnostics.length, 1);
  assert.equal(once.diagnostics[0].kind, 'delayed');
  assert.equal(once.fullMeshMsAvg, 3800 / 9);
});

test('backoff supplies an exact retry wake and waits for active request completion', () => {
  const scheduler = new ChunkScheduler();
  const chunk = { ...entry('retry', 'checking'), retryAt: 5100 };
  planFixtureDemands(scheduler, new Map([[chunk.key, chunk]]), 100);
  scheduler.notify({ type: 'hashNeeded', key: chunk.key });
  const input = {
    now: 100,
    activeHashBatches: 0,
    activeFetchBatches: 0,
    activeMeshTasks: 0,
    maxMeshTasks: 1,
    entries: new Map([[chunk.key, chunk]]),
    includeFetch: false,
    includeMesh: false,
  };
  const waiting = scheduler.nextWork(input);
  assert.deepEqual(waiting.hashBatches, []);
  assert.equal(waiting.hashWakeAt, 5100);
  assert.equal(scheduler.nextWork({ ...input, activeHashBatches: 2 }).hashWakeAt, null);
  planFixtureDemands(scheduler, input.entries, 5100);
  assert.equal(scheduler.nextWork({ ...input, now: 5100 }).hashBatches[0][0], chunk.key);
});
