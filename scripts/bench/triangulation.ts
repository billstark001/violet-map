import assert from 'node:assert/strict';
import { pointInRing, triangulateRing } from '../../packages/render/src/overlays.js';
import type { Vec2 } from '../../packages/core/src/overlayTypes.js';
import { validateFeature } from '../../packages/core/src/overlays.js';

const reports = [];

for (const count of [64, 512, 2048])
  for (const shape of ['convex', 'star']) {
    const ring: Vec2[] = Array.from({ length: count }, (_, index) => {
      const angle = (index * Math.PI * 2) / count;
      const radius = shape === 'star' && index % 2 ? 60 : 100;
      return [Math.cos(angle) * radius, Math.sin(angle) * radius];
    });
    let twiceArea = 0;
    for (let index = 0; index < count; index++) {
      const a = ring[index],
        b = ring[(index + 1) % count];
      twiceArea += a[0] * b[1] - b[0] * a[1];
    }
    const triangles = triangulateRing(ring);
    let triangleArea = 0;
    for (let index = 0; index < triangles.length; index += 3) {
      const a = ring[triangles[index]],
        b = ring[triangles[index + 1]],
        c = ring[triangles[index + 2]];
      triangleArea += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
      assert.ok(pointInRing([(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3], ring));
    }
    assert.ok(Math.abs(triangleArea / twiceArea - 1) < 1e-10);
    const timings = [],
      validationTimings = [];
    const area = {
      featureId: 'region',
      kind: 'area',
      ring,
      minY: 0,
      maxY: 100,
      fill: { color: '#8844ff', opacity: 0.4 },
      wall: { color: '#8844ff', opacity: 0.4, occlusion: 'terrain' },
    };
    for (let round = 0; round < 25; round++) {
      const start = performance.now();
      const output = triangulateRing(ring);
      const elapsed = performance.now() - start;
      assert.equal(output.length, triangles.length);
      const validationStart = performance.now();
      validateFeature(area);
      const validationElapsed = performance.now() - validationStart;
      if (round >= 5) {
        timings.push(elapsed);
        validationTimings.push(validationElapsed);
      }
    }
    timings.sort((a, b) => a - b);
    validationTimings.sort((a, b) => a - b);
    reports.push({ count, shape, p50Ms: timings[10], p95Ms: timings[18], validationP50Ms: validationTimings[10] });
  }

console.log(
  JSON.stringify(
    {
      node: process.version,
      measuredRounds: 20,
      includes: 'triangulation and input geometry validation timed separately; area/centroid assertions excluded',
      reports,
    },
    null,
    2,
  ),
);
