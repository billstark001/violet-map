import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OverlayFeature } from '@violet-map/core/overlays';
import { curveSamplingBudget, planOverlayAdmission, type OverlayCandidate } from '../src/scheduling/overlayPlanner.js';

const limits = {
  activeFeatures: 2,
  curvePointsPerFeature: 10,
  curvePointsTotal: 12,
  curveDepth: 18,
  curveToleranceCssPixels: 0.5,
};
const curve = { kind: 'curve', style: { opacity: 1 } } as OverlayFeature;

const candidate = (key: string, patch: Partial<OverlayCandidate> = {}): OverlayCandidate => ({
  key,
  feature: curve,
  spatiallyVisible: true,
  retryAt: undefined,
  active: false,
  curvePoints: 0,
  ...patch,
});

test('overlay admission preserves explicit order, excludes invisible styles and releases overflow', () => {
  const result = planOverlayAdmission(
    [
      candidate('hidden', { spatiallyVisible: false }),
      candidate('transparent', { feature: { kind: 'curve', style: { opacity: 0 } } as OverlayFeature }),
      candidate('first'),
      candidate('second'),
      candidate('overflow'),
    ],
    { now: 1, topView: false, projectionChanged: true },
    limits,
  );
  assert.deepEqual(
    result.admitted.map((item) => item.key),
    ['first', 'second'],
  );
  assert.deepEqual(result.release, ['hidden', 'transparent', 'overflow']);
  assert.equal(result.suppressed, 1);
});

test('retrying features retain their admission slot without starting work early', () => {
  const result = planOverlayAdmission(
    [
      candidate('retry', { retryAt: 10 }),
      candidate('resident', { active: true, curvePoints: 4 }),
      candidate('overflow'),
    ],
    { now: 5, topView: false, projectionChanged: false },
    limits,
  );
  assert.deepEqual(result.admitted, [{ key: 'resident', activate: false, sample: false }]);
  assert.deepEqual(result.release, ['overflow']);
  assert.deepEqual(curveSamplingBudget(9, 4, limits), { tolerance: 0.5, maxDepth: 18, maxPoints: 7 });
  assert.equal(curveSamplingBudget(20, 2, limits).maxPoints, 0);
});

test('top-view fill and media view eligibility use the same admission contract', () => {
  const area = { kind: 'area', fill: { opacity: 1 }, wall: { opacity: 0 } } as OverlayFeature;
  const media = { kind: 'media', views: ['player'] } as OverlayFeature;
  const candidates = [candidate('area', { feature: area }), candidate('media', { feature: media })];
  assert.deepEqual(
    planOverlayAdmission(
      candidates,
      {
        now: 0,
        topView: true,
        projectionChanged: false,
      },
      limits,
    ).admitted.map((item) => item.key),
    ['area'],
  );
  assert.deepEqual(
    planOverlayAdmission(
      candidates,
      {
        now: 0,
        topView: false,
        projectionChanged: false,
      },
      limits,
    ).admitted.map((item) => item.key),
    ['media'],
  );
});
