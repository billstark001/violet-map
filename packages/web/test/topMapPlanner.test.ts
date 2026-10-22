import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planTopMapTiles, topMapViewMetrics } from '../src/scheduling/topMapPlanner.js';
import type { RegionCoordinate } from '../src/view/topMapCoverage.js';
import { testView } from './helpers/scheduling.js';

test('wide views visit existing tiles without scanning empty grid coordinates', () => {
  const regions = new Map<string, RegionCoordinate>([
    ['0,0', { rx: 0, rz: 0, key: '0,0' }],
    ['100,100', { rx: 100, rz: 100, key: '100,100' }],
  ]);
  assert.deepEqual(
    [
      ...planTopMapTiles(regions, {
        bounds: { minRx: -1_000_000, maxRx: 1_000_000, minRz: -1_000_000, maxRz: 1_000_000 },
        cameraX: 0,
        cameraZ: 0,
        limit: 96,
        mode: 'perspective',
        zoom: 1,
      }),
    ].map((region) => region.key),
    ['0,0', '100,100'],
  );
  assert.deepEqual(
    [
      ...planTopMapTiles(regions, {
        bounds: { minRx: 0, maxRx: 0, minRz: 0, maxRz: 0 },
        cameraX: 0,
        cameraZ: 0,
        limit: 96,
        mode: 'perspective',
        zoom: 1,
      }),
    ].map((region) => region.key),
    ['0,0'],
  );
});

test('equal-distance tiles have stable admission and never leak beyond the radial cutoff', () => {
  const regions = new Map<string, RegionCoordinate>([
    ['0,0', { rx: 0, rz: 0, key: '0,0' }],
    ['-1,-1', { rx: -1, rz: -1, key: '-1,-1' }],
  ]);
  const input = {
    bounds: { minRx: -2, maxRx: 2, minRz: -2, maxRz: 2 },
    cameraX: 0,
    cameraZ: 0,
    limit: 1,
    mode: 'perspective' as const,
    zoom: 1,
  };
  assert.deepEqual(
    planTopMapTiles(regions, input).map((tile) => [tile.key, tile.step]),
    [['-1,-1', 2]],
  );
  assert.deepEqual(planTopMapTiles(regions, { ...input, maxDistanceBlocks: 100 }), []);
  assert.equal(planTopMapTiles(regions, { ...input, mode: 'top', zoom: 2.5 })[0].step, 2);
});

test('top-view extents and demanded detail use the effective projection zoom', () => {
  const view = { ...testView, mode: 'top' as const };
  const normal = topMapViewMetrics(view);
  const zoomed = topMapViewMetrics({ ...view, projection: { ...view.projection, zoom: 3 } });
  assert.equal(zoomed.height, normal.height / 3);
  assert.equal(zoomed.width, normal.width / 3);
  assert.equal(zoomed.zoom, normal.zoom * 3);
  assert.deepEqual(
    topMapViewMetrics({
      ...view,
      projection: { kind: 'orthographic', left: -200, right: 600, top: 300, bottom: -100, near: 0.1, zoom: 2 },
    }),
    { width: 400, height: 200, zoom: 2 },
  );
});
