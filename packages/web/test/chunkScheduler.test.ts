import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { ChunkScheduler, type ChunkSchedulerEntry, schedulerTuningForPreset } from '../src/render/chunkScheduler.js';

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
  for (let frame = 0; frame < 400; frame++) {
    const now = frame * 100;
    const result = scheduler.tick({
      camera,
      now,
      force: false,
      options,
      keyFor,
      entryFor: (key) => entries.get(key) ?? null,
      cellInfoFor: () => ({ hasChunkSource: true, topMapSurfaceY: 64 }),
      entries: [...entries.values()],
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
  }
  assert.ok(admissions > 197, 'the test must exercise capacity beyond the guaranteed near disk');
  assert.equal(stableAdmissions, 0);
  assert.equal(stableEvictions, 0);
});
