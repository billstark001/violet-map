import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CameraGridTracker, type Pose } from '../src/scheduler/cameraGridTracker.js';

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

  assert.equal(
    tracker.deleteChunksWhere(() => true),
    1,
  );
  assert.equal(tracker.chunkCount, activeCount);
  assert.equal(tracker.getHeight(0, 0), 1);
  assert.equal(tracker.getHeight(100, 100), 1);
});
