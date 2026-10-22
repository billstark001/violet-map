import { schedulerTuningForPreset } from '../src/scheduling/profiles.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { ChunkScheduler } from '../src/scheduling/chunkScheduler.js';
import { type ChunkSchedulerEntry } from '../src/scheduling/contracts.js';

test('scheduler presets keep finite radii for invalid distance settings', () => {
  for (const preset of ['potato', 'low', 'medium', 'high', 'extreme'] as const) {
    const tuning = schedulerTuningForPreset(preset, NaN, Infinity);
    assert.ok(Number.isFinite(tuning.activeRadiusChunks));
    assert.ok(Number.isFinite(tuning.distanceInverseSquareRadiusChunks));
  }
});

test('a capacity-limited stationary view admits a stable set instead of evicting completed terrain forever', () => {
  const camera = new THREE.PerspectiveCamera(75, 1.44, 0.1, 10000);
  camera.position.set(-28, 79, -25);
  camera.lookAt(-28, 65, 100);
  camera.updateMatrixWorld();
  const scheduler = new ChunkScheduler();
  const entries = new Map<string, ChunkSchedulerEntry>();
  const keyFor = (cx: number, cz: number) => `${cx},${cz}`;
  const options = { scheduling: schedulerTuningForPreset('medium', 8, 12) };
  let admissions = 0;
  let stableAdmissions = 0;
  let stableEvictions = 0;
  let fullChecks = 0;
  for (let frame = 0; frame < 400; frame++) {
    const now = frame * 100;
    const result = scheduler.tick({
      camera,
      now,
      options,
      keyFor,

      cellInfoFor: () => ({ hasChunkSource: true, topMapSurfaceY: 64 }),
      entries,
    });
    const updates = new Map(result.entryUpdates.map((u) => [u.key, u]));
    for (const action of result.actions) {
      if (action.type === 'dropChunk') {
        entries.delete(action.key);
        scheduler.notify({ type: 'chunkDropped', key: action.key });
        if (now > 20000) stableEvictions++;
      }
      if (action.type === 'wantChunk') {
        admissions++;
        if (now > 20000) stableAdmissions++;
        entries.set(action.key, {
          ...updates.get(action.key)!,
          key: action.key,
          cx: action.cx,
          cz: action.cz,
          state: 'stored',
          displayed: 'none',
          displayedLodStep: 0,
          displayedVersion: -1,
          dirty: false,
          pendingFull: false,
          pendingLod: false,
          pendingLodStep: 0,
        });
      }
    }
    for (const update of result.entryUpdates) {
      const entry = entries.get(update.key);
      if (!entry) continue;
      Object.assign(entry, update);
      const dx = entry.cx - result.centerCx,
        dz = entry.cz - result.centerCz;
      if (dx * dx + dz * dz <= 64) {
        assert.equal(update.lastTargetStep, 1, 'full view distance must survive completed neighbors and falling gaps');
        fullChecks++;
      }
      entry.displayed = update.lastTargetStep === 1 ? 'full' : 'lod';
      entry.displayedLodStep = update.lastTargetStep === 1 ? 0 : update.lastTargetStep;
      entry.displayedVersion = frame;
      scheduler.notify({
        type: 'meshDisplayed',
        entry,
        kind: update.lastTargetStep === 1 ? 'full' : 'lod',
        step: update.lastTargetStep,
        version: frame,
        now,
      });
    }
    assert.ok(entries.size <= 384);
    if (now > 20000)
      for (const entry of entries.values()) {
        const dx = entry.cx - result.centerCx,
          dz = entry.cz - result.centerCz;
        if (dx * dx + dz * dz <= 64) assert.equal(entry.displayed, 'full', 'settled quality was downgraded');
      }
  }
  assert.ok(admissions > 197, 'the test must exercise capacity beyond the guaranteed near disk');
  assert.equal(stableAdmissions, 0);
  assert.equal(stableEvictions, 0);
  assert.ok(fullChecks >= 197, 'the complete full-detail disk was requested');
  for (let dx = -8; dx <= 8; dx++)
    for (let dz = -8; dz <= 8; dz++) {
      if (dx * dx + dz * dz > 64) continue;
      const entry = entries.get(keyFor(-2 + dx, -2 + dz));
      assert.equal(entry?.displayed, 'full', `view-distance hole at ${dx},${dz}`);
    }
});

test('all scheduling profiles preserve requested quality and reserve capacity for the full disk', () => {
  for (const preset of ['potato', 'low', 'medium', 'high', 'extreme'] as const)
    for (const radius of [2, 8, 16, 32]) {
      const tuning = schedulerTuningForPreset(preset, radius, 12);
      assert.equal(tuning.fullDetailRadiusChunks, radius);
      assert.ok(tuning.activeRadiusChunks! >= radius);
      let count = 0;
      for (let x = -radius; x <= radius; x++)
        for (let z = -radius; z <= radius; z++) if (x * x + z * z <= radius * radius) count++;
      assert.ok(tuning.maxTrackedChunks! >= count, `${preset} cannot retain its promised quality`);
    }
});
