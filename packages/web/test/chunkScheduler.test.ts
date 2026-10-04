import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schedulerTuningForPreset } from '../src/render/chunkScheduler.js';

test('scheduler presets keep finite radii for invalid distance settings', () => {
  for (const preset of ['potato', 'low', 'medium', 'high', 'extreme'] as const) {
    const tuning = schedulerTuningForPreset(preset, NaN, Infinity);
    assert.ok(Number.isFinite(tuning.activeRadiusChunks));
    assert.ok(Number.isFinite(tuning.distanceInverseSquareRadiusChunks));
  }
});
