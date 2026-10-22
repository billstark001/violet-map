import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChunkScheduler } from '../src/scheduling/chunkScheduler.js';
import type { ChunkSchedulerEntry, ReadyMeshTask } from '../src/scheduling/contracts.js';
import { planFixtureDemands } from './helpers/scheduling.js';

function entry(key: string, cx: number): ChunkSchedulerEntry {
  return {
    key,
    cx,
    cz: 0,
    state: 'stored',
    workerPins: 0,
    displayed: 'none',
    displayedLodStep: 0,
    displayedVersion: -1,
    pendingFull: false,
    pendingLod: false,
    pendingLodStep: 0,
    dirty: false,
  };
}

test('Worker dispatch applies current priorities after cache completion and assigns the free worker', () => {
  const scheduler = new ChunkScheduler();
  const early = entry('early', 0),
    urgent = entry('urgent', 1);
  const entries = new Map([
    [early.key, early],
    [urgent.key, urgent],
  ]);
  planFixtureDemands(
    scheduler,
    entries,
    100,
    () => 1,
    (entry) => ({ tier: entry.key === 'urgent' ? -2 : 2, score: 0 }),
  );
  early.pendingFull = urgent.pendingFull = true;
  const ready: ReadyMeshTask[] = [
    { entry: early, kind: 'full', step: 1, version: 1 },
    { entry: urgent, kind: 'full', step: 1, version: 2 },
  ];
  const plan = scheduler.dispatchWorkers({
    entries,
    now: 100,
    maxTasks: 2,
    workerLoads: [1, 0],
    ready,
  });
  assert.deepEqual(
    plan.start.map(({ task, workerIndex }) => [task.entry.key, workerIndex]),
    [['urgent', 1]],
  );
  assert.deepEqual(plan.discard, []);
});

test('waiting jobs are revalidated against target quality, entry identity and demand age', () => {
  const scheduler = new ChunkScheduler();
  const chunk = entry('chunk', 0);
  const entries = new Map([[chunk.key, chunk]]);
  planFixtureDemands(scheduler, entries, 100, () => 2);
  const ready: ReadyMeshTask[] = [{ entry: chunk, kind: 'lod', step: 8, version: 1 }];
  const input = { entries, now: 100, maxTasks: 1, workerLoads: [0], ready };
  assert.deepEqual(scheduler.dispatchWorkers(input), { start: [], discard: [1] });
  ready[0] = { ...ready[0], step: 2 };
  assert.equal(scheduler.dispatchWorkers(input).start.length, 1);
  assert.deepEqual(scheduler.dispatchWorkers({ ...input, now: 4000 }), { start: [], discard: [1] });
  entries.set(chunk.key, { ...chunk });
  assert.deepEqual(scheduler.dispatchWorkers(input), { start: [], discard: [1] });
});

test('executor metadata cannot create or override camera demand', () => {
  const scheduler = new ChunkScheduler();
  const chunk = Object.assign(entry('chunk', 0), { lastWantedAt: 100, lastTargetStep: 1 });
  const entries = new Map([[chunk.key, chunk]]);
  const input = { entries, now: 100, activeMeshTasks: 0, maxMeshTasks: 1, activeHashBatches: 0, activeFetchBatches: 0 };
  scheduler.notify({ type: 'hashNeeded', key: chunk.key });
  assert.deepEqual(scheduler.nextWork(input).meshTasks, []);
  assert.equal(scheduler.shouldAcceptMeshResult({ entry: chunk, kind: 'full', step: 1, version: 1, now: 100 }), false);
  planFixtureDemands(scheduler, entries, 100, () => 4);
  chunk.lastTargetStep = 1;
  assert.equal(scheduler.demandFor(chunk.key)!.targetStep, 4);
  assert.equal(scheduler.nextWork(input).meshTasks[0].step, 4);
});
