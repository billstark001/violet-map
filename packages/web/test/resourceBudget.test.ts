import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveViewerResourceBudget, workerResidentColumnLimit } from '../src/scheduling/resourceBudget.js';
import { selectResidencyReleases, type WorkerResidencyEntry } from '../src/scheduling/chunkResidency.js';
import { selectChunkEvictions } from '../src/scheduling/chunkRetention.js';
import { resolveChunkScheduling } from '../src/scheduling/chunkPolicy.js';
import { displayedGeometryPrecision, validGeometryPrecision, precisionForStep } from '../src/scheduling/chunkPolicy.js';

const budget = resolveViewerResourceBudget({
  hardwareConcurrency: 16,
  deviceMemoryGiB: null,
  requestedMeshWorkers: null,
});

test('hardware budgets bound shared Worker copies without changing quality configuration', () => {
  assert.equal(budget.meshWorkers, 2);
  assert.equal(workerResidentColumnLimit(budget, 2), 384);
  assert.equal(
    resolveViewerResourceBudget({ hardwareConcurrency: 2, deviceMemoryGiB: 4, requestedMeshWorkers: 4 }).meshWorkers,
    1,
  );
  assert.equal(
    resolveViewerResourceBudget({ hardwareConcurrency: 16, deviceMemoryGiB: 4, requestedMeshWorkers: null })
      .topMapResidentTiles,
    48,
  );
  assert.throws(() => workerResidentColumnLimit(budget, 0), /live workers/);
});

function resident(key: string): WorkerResidencyEntry {
  return {
    key,
    cx: 0,
    cz: 0,
    state: 'stored',
    displayed: 'full',
    displayedLodStep: 0,
    displayedVersion: 1,
    pendingFull: false,
    pendingLod: false,
    pendingLodStep: 0,
    dirty: false,
    workerPins: 0,
    workerKeepUntil: 0,
    contentDigest: 'digest',
    estimatedColumnBytes: 100,
    workerCopies: 2,
  };
}

test('residency pressure releases satisfied inputs while protecting in-flight dependencies and geometry', () => {
  const pinned = { ...resident('pinned'), workerPins: 1 };
  const plan = selectResidencyReleases({
    entries: [pinned, resident('complete')],
    keepKeys: new Set(['pinned', 'complete']),
    workers: 2,
    now: 100,
    budget: { ...budget, workerBytes: 200 },
    demandFor: () => undefined,
    isSatisfied: () => true,
  });
  assert.deepEqual(plan, { workerKeys: ['complete'], meshKeys: [] });
  assert.equal(pinned.displayed, 'full');
});

test('presentation quality and repair validity are explicit independent measurements', () => {
  const stale = { ...resident('stale'), dirty: true };
  assert.equal(displayedGeometryPrecision(stale), 1);
  assert.equal(validGeometryPrecision(stale), 0);
  assert.throws(() => precisionForStep(3), /invalid LOD/);
});

test('tracked-entry eviction protects actual dependency pins and pending tasks in the planner', () => {
  const pinned = { ...resident('pinned'), workerPins: 1 };
  const pending = { ...resident('pending'), pendingFull: true };
  const idle = resident('idle');
  const input = {
    entries: [pinned, pending, idle],
    keepKeys: new Set<string>(),
    protectedKeys: new Set<string>(),
    now: 10_000,
    reservedSlots: 0,
    config: resolveChunkScheduling(),
    center: { cx: 0, cz: 0 },
    demandFor: () => undefined,
  };
  assert.deepEqual(selectChunkEvictions(input), ['idle']);
  pinned.workerPins = 0;
  pending.pendingFull = false;
  assert.deepEqual(new Set(selectChunkEvictions(input)), new Set(['pinned', 'pending', 'idle']));
});
