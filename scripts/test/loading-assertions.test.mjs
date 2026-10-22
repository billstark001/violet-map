import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertFullDetailCoverage } from '../bench/loading-assertions.mjs';

test('quality acceptance uses the service world ID and distinguishes source holes from coarse terrain', () => {
  const chunk = { cx: -1, cz: -1, state: 'stored', displayed: 'full' };
  const manager = {
    world: 'scope:with:colons:Surv#Vanilla',
    dimension: 'minecraft:overworld',
    scheduling: { center: { cx: -1, cz: -1 }, fullDetailRadiusChunks: 8 },
    chunks: [chunk],
  };
  const mask = new Uint8Array(128);
  mask[127] = 128; // (-1,-1) is cell (31,31) of region (-1,-1).
  const coverage = new Map([
    ['Surv#Vanilla\0minecraft:overworld', { chunks: new Set(), regions: new Map([['-1,-1', mask]]) }],
  ]);
  assert.doesNotThrow(() => assertFullDetailCoverage(manager, 'Surv#Vanilla', coverage));
  chunk.displayed = 'lod';
  assert.throws(() => assertFullDetailCoverage(manager, 'Surv#Vanilla', coverage), /remained coarse/);
  chunk.state = 'absent';
  assert.doesNotThrow(() => assertFullDetailCoverage(manager, 'Surv#Vanilla', coverage));
  assert.throws(() => assertFullDetailCoverage(manager, 'Surv#Vanilla', new Map()), /not observed/);
  coverage.values().next().value.regions.set('-1,-1', undefined);
  assert.throws(() => assertFullDetailCoverage(manager, 'Surv#Vanilla', coverage), /never admitted/);
});
