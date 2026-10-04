import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateRegionCoords, type RegionCoordinate } from '../src/render/tileCandidates.js';

test('wide views visit existing tiles without scanning empty grid coordinates', () => {
  const regions = new Map<string, RegionCoordinate>([
    ['0,0', { rx: 0, rz: 0, key: '0,0' }],
    ['100,100', { rx: 100, rz: 100, key: '100,100' }],
  ]);
  assert.deepEqual(
    [
      ...candidateRegionCoords(regions, { minRx: -1_000_000, maxRx: 1_000_000, minRz: -1_000_000, maxRz: 1_000_000 }),
    ].map((region) => region.key),
    ['0,0', '100,100'],
  );
  assert.deepEqual(
    [...candidateRegionCoords(regions, { minRx: 0, maxRx: 0, minRz: 0, maxRz: 0 })].map((region) => region.key),
    ['0,0'],
  );
});
