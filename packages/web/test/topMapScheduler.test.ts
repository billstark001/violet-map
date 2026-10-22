import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TopMapScheduler } from '../src/scheduling/topMapScheduler.js';
import { testView } from './helpers/scheduling.js';
import type { ViewState } from '../src/view/state.js';
import type { RegionCoordinate } from '../src/view/topMapCoverage.js';

const topView: ViewState = {
  ...testView,
  mode: 'top',
  position: { x: 256, y: 100, z: 256 },
  projection: { kind: 'orthographic', left: -256, right: 256, top: 256, bottom: -256, near: 0.1, zoom: 1 },
};
const regions = new Map<string, RegionCoordinate>([
  ['0,0', { key: '0,0', rx: 0, rz: 0 }],
  ['1,0', { key: '1,0', rx: 1, rz: 0 }],
  ['10,0', { key: '10,0', rx: 10, rz: 0 }],
]);

test('Top Map async completion reads the latest authoritative demand and retention is planned separately', () => {
  const scheduler = new TopMapScheduler(1);
  const input = {
    view: topView,
    now: 0,
    regions,
    pending: new Set<string>(),
    failed: new Map<string, number>(),
    onlineChunks: new Set<string>(),
  };
  assert.deepEqual(
    scheduler.plan(input)!.load.map((tile) => [tile.key, tile.step]),
    [['0,0', 8]],
  );
  assert.equal(scheduler.plan({ ...input, now: 50 }), null);
  scheduler.plan({ ...input, now: 100, view: { ...topView, projection: { ...topView.projection, zoom: 3 } } });
  assert.equal(scheduler.demandFor('0,0')!.step, 2);
  scheduler.loaded('0,0', 100);
  const moved = scheduler.plan({
    ...input,
    now: 200,
    pending: new Set(['0,0']),
    view: { ...topView, position: { x: 5376, y: 100, z: 256 } },
  })!;
  assert.deepEqual(moved.cancel, ['0,0']);
  assert.deepEqual(
    moved.load.map((tile) => tile.key),
    ['10,0'],
  );
  scheduler.loaded('10,0', 200);
  assert.deepEqual(
    scheduler.plan({
      ...input,
      now: 300,
      view: { ...topView, position: { x: 5376, y: 100, z: 256 } },
    })!.evict,
    ['0,0'],
  );
  scheduler.clear();
  assert.equal(scheduler.demandFor('10,0'), undefined);
  assert.throws(() => scheduler.residentSince('10,0'), /not registered/);
});

test('full online coverage avoids downloads and failure deadlines do not change demanded quality', () => {
  const scheduler = new TopMapScheduler(1);
  const input = {
    view: topView,
    now: 0,
    regions,
    pending: new Set<string>(),
    failed: new Map([['0,0', 0]]),
    onlineChunks: new Set<string>(),
  };
  assert.deepEqual(scheduler.plan(input)!.load, []);
  assert.equal(scheduler.demandFor('0,0')!.step, 8);
  assert.equal(scheduler.plan({ ...input, now: 12000 })!.load.length, 1);
  const online = new Set<string>();
  for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) online.add(x + ',' + z);
  assert.deepEqual(scheduler.plan({ ...input, now: 12100, onlineChunks: online })!.load, []);
});

test('height slices do not request surface-only Top Map representations', () => {
  const scheduler = new TopMapScheduler(1);
  const plan = scheduler.plan({
    view: { ...topView, clip: { minY: 16, maxY: 64 } },
    now: 0,
    regions,
    pending: new Set(['0,0']),
    failed: new Map(),
    onlineChunks: new Set(),
  })!;
  assert.equal(plan.wanted.size, 0);
  assert.deepEqual(plan.load, []);
  assert.deepEqual(plan.cancel, ['0,0']);
});
