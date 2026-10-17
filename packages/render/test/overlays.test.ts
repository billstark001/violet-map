import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  areaMaskLayout,
  areaMaskUv,
  buildAreaFill,
  buildAreaWall,
  curveBounds,
  cubicPoint,
  mediaBounds,
  pointInRing,
  projectPoint,
  sampleCurve,
  triangulateRing,
  type Projection,
} from '../src/overlays.js';
import type { AreaFeature, CurveFeature, Vec3, MediaFeature, MediaVersion } from '@violet-map/core/overlays';
const curve: CurveFeature = {
  featureId: 'c',
  kind: 'curve',
  closed: false,
  nodes: [
    { anchor: [-30, 0, -30], in: [0, 0, 0], out: [80, 80, 10] },
    { anchor: [30, 10, -80], in: [-80, 60, 30], out: [0, 0, 0] },
  ],
  style: { color: '#aa44ff', opacity: 1, width: 2, widthUnit: 'pixels' },
};
const style = { color: '#aa44ff', opacity: 0.5 };
const area: AreaFeature = {
  featureId: 'a',
  kind: 'area',
  ring: [
    [0, 0],
    [10, 0],
    [10, 3],
    [3, 3],
    [3, 10],
    [0, 10],
  ],
  minY: -32,
  maxY: 128,
  fill: style,
  wall: { ...style, occlusion: 'terrain' },
};
function distance(p: number[], a: number[], b: number[]) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}
test('adaptive cubic samples stay within 0.5 CSS pixels in perspective and orthographic projections', () => {
  const projections: Projection[] = [
    { matrix: [0.02, 0, 0, 0, 0, 0.02, 0, 0, 0, 0, -0.01, 0, 0, 0, 0, 1], width: 1024, height: 768 },
    { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0], width: 1024, height: 768 },
  ];
  const control: Vec3[] = [curve.nodes[0].anchor, [50, 80, -20], [-50, 70, -50], curve.nodes[1].anchor];
  for (const projection of projections) {
    const sampled = sampleCurve(curve, { projection, tolerance: 0.5 });
    assert.equal(sampled.capped, false);
    const points = sampled.points.map((p) => projectPoint(p, projection));
    let maximum = 0;
    for (let i = 0; i <= 4000; i++) {
      const p = projectPoint(cubicPoint(control, i / 4000), projection);
      maximum = Math.max(maximum, Math.min(...points.slice(1).map((b, j) => distance(p, points[j], b))));
    }
    assert.ok(maximum <= 0.51, `projection error ${maximum}`);
  }
  const coarse = sampleCurve(curve, { maxPoints: 8, tolerance: 1e-10 });
  assert.equal(coarse.capped, true);
  assert.ok(coarse.points.length <= 8);
});
test('hulls conservatively contain overshooting handles, closures and degenerate segments without smoothing', () => {
  const bounds = curveBounds(curve);
  assert.deepEqual(bounds, { min: [-50, 0, -80], max: [50, 80, -20] });
  const closed: CurveFeature = {
    ...curve,
    closed: true,
    nodes: [...curve.nodes, { anchor: [0, 0, -50], in: [0, 0, 0], out: [0, 0, 0] }],
  };
  const sampled = sampleCurve(closed);
  assert.deepEqual(sampled.points[0], sampled.points.at(-1));
  const zero = {
    ...curve,
    nodes: [curve.nodes[0], { ...curve.nodes[0], out: [0, 0, 0] as Vec3, in: [0, 0, 0] as Vec3 }],
  };
  assert.ok(sampleCurve(zero).points.every((point) => point.every(Number.isFinite)));
});
test('concave masks and double-sided wall topology preserve contour and finite absolute heights', () => {
  for (const ring of [
    area.ring,
    [...area.ring].reverse(),
    [
      [0, 0],
      [5, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ] as [number, number][],
  ]) {
    const indices = triangulateRing(ring);
    let sum = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const a = ring[indices[i]],
        b = ring[indices[i + 1]],
        c = ring[indices[i + 2]];
      sum += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
      assert.equal(pointInRing([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3], ring), true);
    }
    assert.equal(sum, ring.length === 5 ? 100 : 51);
  }
  const wall = buildAreaWall(area);
  assert.equal(wall.positions.length, area.ring.length * 12);
  assert.equal(wall.indices.length, area.ring.length * 6);
  for (let i = 1; i < wall.positions.length; i += 3)
    assert.ok([area.minY, area.maxY].includes(wall.positions[i] + wall.origin[1]));
  const distant = { ...area, ring: area.ring.map(([x, z]) => [x + 30_000_000, z + 30_000_000] as [number, number]) };
  assert.equal(buildAreaFill(distant).positions[3], 10);
});
test('world-XZ mask UVs are height-independent, bounded, and report resolution caps', () => {
  const layout = areaMaskLayout({ min: [0, 0], max: [64, 128] }, 0.5);
  assert.equal(layout.limited, false);
  const uv = areaMaskUv([32, 64], layout);
  assert.ok(uv.every((v) => v > 0 && v < 1));
  const huge = areaMaskLayout({ min: [-10000, -10000], max: [10000, 10000] }, 0.001, 256);
  assert.equal(huge.limited, true);
  assert.ok(huge.width <= 256 && huge.height <= 256);
});
test('media bounds include anchor, intrinsic orientation, scale, Euler rotations and billboard pivot', () => {
  const f: MediaFeature = {
    featureId: 'm',
    kind: 'media',
    assetId: 'a',
    versionId: 'v',
    position: [10, 64, 20],
    rotation: [0, 0, 0],
    scale: [2, 3, 4],
    views: ['top'],
    placement: 'plane',
    size: [10, 5],
    anchor: [0, 0],
  };
  assert.deepEqual(mediaBounds(f, {} as MediaVersion), { min: [10, 64, 0], max: [30, 64, 20] });
  const model = {
    ...f,
    placement: 'model' as const,
    size: undefined,
    anchor: undefined,
    rotation: [0, Math.PI / 2, 0] as Vec3,
  };
  const bounds = mediaBounds(model, { bounds: { min: [0, 0, 0], max: [1, 2, 3] } } as MediaVersion);
  assert.ok(Math.abs(bounds.max[0] - 22) < 1e-8);
  assert.equal(bounds.max[1], 70);
  assert.ok(Math.abs(bounds.min[2] - 18) < 1e-8);
  const billboard = mediaBounds({ ...f, placement: 'billboard' }, {} as MediaVersion);
  assert.ok(billboard.min[0] < 10 && billboard.max[0] > 30);
});
