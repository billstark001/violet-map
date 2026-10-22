import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CameraGridTracker, type Pose } from '../src/scheduling/cameraGridTracker.js';

const origin: Pose = { p: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 };

test('the active-cell limit is optional', () => {
  const tracker = new CameraGridTracker({ k: 1, m: 1 });
  assert.equal(tracker.updateCamera(0, origin).activeCount, 4);
});

test('an oversized camera update does not integrate the previous pose twice', () => {
  const config = { k: 1, m: 1, maxActiveCells: 4 };
  const retried = new CameraGridTracker(config);
  const direct = new CameraGridTracker(config);
  retried.updateCamera(0, origin);
  direct.updateCamera(0, origin);
  assert.throws(() => retried.updateCamera(1, { ...origin, p: { x: 0.5, y: 0, z: 0.5 } }), /maxActiveCells/);
  retried.updateCamera(1, origin);
  direct.updateCamera(1, origin);
  assert.equal(retried.getCellSnapshot(0, 0).importance, direct.getCellSnapshot(0, 0).importance);
});

test('chunk cleanup retains chunks referenced by the active disk', () => {
  const tracker = new CameraGridTracker({ k: 1, m: 1, chunkSize: 1 });
  tracker.updateCamera(0, origin);
  tracker.setHeight(100, 100, 42);
  const activeCount = tracker.activeCount;

  assert.equal(tracker.trimInactiveChunks(0, []), 1);
  assert.equal(tracker.chunkCount, activeCount);
  assert.equal(tracker.getHeight(0, 0), 1);
  assert.equal(tracker.getHeight(100, 100), 1);
});

test('selected rankings agree with complete rankings without allocating unused result sets', () => {
  const tracker = new CameraGridTracker({ k: 1, m: 8 });
  tracker.updateCamera(0, origin);
  tracker.setPrecision(0, 0, 1);
  const selection = { importance: 'top', gap: 'top' } as const;
  const selected = tracker.advanceTime(1, 10, selection);
  const complete = tracker.query(10);
  assert.deepEqual(selected.importance.top, complete.importance.top);
  assert.deepEqual(selected.gap.top, complete.gap.top);
  assert.deepEqual(selected.importance.bottom, []);
  assert.deepEqual(selected.satisfaction, { top: [], bottom: [] });
  assert.deepEqual(selected.gap.bottom, []);
  const stationary = tracker.updateCamera(2, origin, 10, selection);
  const direct = tracker.query(10);
  assert.deepEqual(stationary.gap.top, direct.gap.top);
});

test('unchanged precision does not recompute satisfaction or add another overshoot', () => {
  let evaluations = 0;
  const tracker = new CameraGridTracker({
    k: 1,
    m: 2,
    precisionToSatisfaction: (value) => {
      evaluations++;
      return value;
    },
    neighborSatisfactionPenaltyByCount: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  });
  tracker.updateCamera(0, origin);
  tracker.setPrecision(0, 0, 0.5);
  const before = tracker.getCellSnapshot(0, 0);
  evaluations = 0;
  for (let i = 0; i < 100; i++) tracker.setPrecision(0, 0, 0.5);
  assert.equal(evaluations, 0);
  const after = tracker.getCellSnapshot(0, 0);
  assert.equal(after.bump, before.bump);
  assert.equal(after.satisfaction, before.satisfaction);
});

test('future ranking and cell observations cannot alter subsequent camera integration', () => {
  const config = { k: 1, m: 4, initialImportance: 0.8 };
  const observed = new CameraGridTracker(config);
  const direct = new CameraGridTracker(config);
  observed.updateCamera(0, origin);
  direct.updateCamera(0, origin);
  for (const time of [10, 100]) {
    observed.query(10, time);
    observed.getCellSnapshot(0, 0, time);
    observed.query(0, time);
  }
  assert.equal(observed.currentTime, 0);
  assert.deepEqual(observed.updateCamera(1, origin, 10), direct.updateCamera(1, origin, 10));
});

test('rank-free camera updates skip satisfaction work and retain positive sub-float32 half-lives', () => {
  let evaluations = 0;
  const tracker = new CameraGridTracker({
    k: 1,
    m: 2,
    nearImportanceHalfLife: 1e-50,
    farImportanceHalfLife: 1e-50,
    precisionToSatisfaction(value) {
      evaluations++;
      return value;
    },
  });
  const before = evaluations;
  tracker.updateCamera(0, origin);
  tracker.updateCamera(1, origin);
  assert.equal(evaluations, before);
  assert.ok(tracker.getCellSnapshot(0, 0).importance > 0);
  assert.equal(tracker.getCellSnapshot(0, 0, 2).importance, 0, 'decay uses the selected tiny half-life, not a default');
});

test('moving camera history is bounded while active and explicitly protected cells survive', () => {
  const tracker = new CameraGridTracker({ k: 1, m: 4, chunkSize: 8 });
  tracker.setHeight(-1000, -1000, 42);
  for (let step = 0; step < 200; step++) {
    tracker.updateCamera(step, { ...origin, p: { x: step * 80, y: 0, z: 0 } });
    tracker.trimInactiveChunks(8, [{ i: -1000, j: -1000 }]);
    assert.ok(tracker.chunkCount <= 13);
  }
  assert.equal(tracker.getHeight(-1000, -1000), 42);
  assert.equal(tracker.activeCount, 52);
});

test('history removal refreshes retained neighbor satisfaction without changing live precision', () => {
  const tracker = new CameraGridTracker({
    k: 1,
    m: 1,
    chunkSize: 1,
    minSatisfaction: -1,
    neighborSatisfactionPenaltyByCount: [0, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2],
  });
  tracker.updateCamera(0, origin);
  tracker.setPrecision(100, 100, 1);
  assert.equal(tracker.getCellSnapshot(101, 100).satisfaction, -0.2);
  tracker.trimInactiveChunks(0, [{ i: 101, j: 100 }]);
  assert.equal(tracker.getCellSnapshot(101, 100).satisfaction, 0);
  assert.equal(tracker.getPrecision(101, 100), 0);
});
