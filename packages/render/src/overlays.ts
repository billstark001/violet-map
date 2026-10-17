import earcut, { deviation } from 'earcut';
import type {
  AreaFeature,
  CurveFeature,
  MediaFeature,
  MediaVersion,
  Vec2,
  Vec3,
} from '@violet-map/core/overlays/types';

export interface OverlayBounds {
  min: Vec3;
  max: Vec3;
}

export interface Projection {
  matrix: readonly number[];
  width: number;
  height: number;
}

const mix = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** Axis-aligned bounds of finite world points, expanded uniformly by padding. */
export function boundsOf(points: readonly Vec3[], padding = 0): OverlayBounds {
  const min: Vec3 = [Infinity, Infinity, Infinity],
    max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const point of points)
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], point[axis] - padding);
      max[axis] = Math.max(max[axis], point[axis] + padding);
    }
  if ([...min, ...max].some((v) => !Number.isFinite(v))) throw new Error('nonfinite overlay bounds');
  return { min, max };
}

/** Conservative world bounds using every cubic control point, including closure. */
export function curveBounds(curve: CurveFeature, padding = 0): OverlayBounds {
  const points: Vec3[] = [];
  for (let i = 0; i < curve.nodes.length - (curve.closed ? 0 : 1); i++) {
    const a = curve.nodes[i],
      b = curve.nodes[(i + 1) % curve.nodes.length];
    points.push(a.anchor, add(a.anchor, a.out), add(b.anchor, b.in), b.anchor);
  }
  return boundsOf(points, padding);
}

/** Project through a column-major matrix into centered CSS-pixel coordinates;
 * the third result is homogeneous W for eye-plane classification. */
export function projectPoint(point: Vec3, projection: Projection): Vec3 {
  const m = projection.matrix,
    [x, y, z] = point;
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [
    (((m[0] * x + m[4] * y + m[8] * z + m[12]) / w) * projection.width) / 2,
    (((m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * projection.height) / 2,
    w,
  ];
}

function distanceToSegment(
  p: readonly number[],
  a: readonly number[],
  b: readonly number[],
  dimensions: number,
): number {
  let dot = 0,
    length = 0;
  for (let i = 0; i < dimensions; i++) {
    dot += (p[i] - a[i]) * (b[i] - a[i]);
    length += (b[i] - a[i]) ** 2;
  }
  const t = length ? Math.max(0, Math.min(1, dot / length)) : 0;
  let squared = 0;
  for (let i = 0; i < dimensions; i++) squared += (p[i] - a[i] - (b[i] - a[i]) * t) ** 2;
  return Math.sqrt(squared);
}

/** Evaluate a cubic with four control points at parameter t (normally 0..1). */
export function cubicPoint(points: readonly Vec3[], t: number): Vec3 {
  const u = 1 - t;
  return [0, 1, 2].map(
    (i) =>
      u * u * u * points[0][i] + 3 * u * u * t * points[1][i] + 3 * u * t * t * points[2][i] + t * t * t * points[3][i],
  ) as Vec3;
}

/** Sample a validated curve within a world-unit or projected CSS-pixel tolerance.
 * Positive homogeneous weights bound projected error by the control hull; point
 * or depth exhaustion retains endpoints and reports capped rather than smoothing. */
export function sampleCurve(
  curve: CurveFeature,
  options: { projection?: Projection; tolerance?: number; maxPoints?: number; maxDepth?: number } = {},
) {
  const tolerance = options.tolerance ?? (options.projection ? 0.5 : 0.125),
    maxPoints = options.maxPoints ?? 65536,
    maxDepth = options.maxDepth ?? 18;
  if (
    !Number.isFinite(tolerance) ||
    !(tolerance > 0) ||
    !Number.isSafeInteger(maxPoints) ||
    maxPoints < curve.nodes.length + 1 ||
    !Number.isSafeInteger(maxDepth) ||
    maxDepth < 1
  )
    throw new Error('invalid curve sampling budget');
  const points: Vec3[] = [curve.nodes[0].anchor];
  let capped = false;
  const segments = curve.nodes.length - (curve.closed ? 0 : 1);
  // Reserve each later segment's endpoint, including the closure.
  const visit = (p: Vec3[], depth: number, reserved: number): void => {
    const projected = options.projection ? p.map((v) => projectPoint(v, options.projection!)) : p;
    const allBehind = options.projection && projected.every((v) => v[2] <= 0);
    const crossesEye = options.projection && projected.some((v) => v[2] <= 1e-8);
    const error = allBehind
      ? 0
      : crossesEye
        ? Infinity
        : Math.max(
            distanceToSegment(projected[1], projected[0], projected[3], options.projection ? 2 : 3),
            distanceToSegment(projected[2], projected[0], projected[3], options.projection ? 2 : 3),
          );
    if (error <= tolerance || depth >= maxDepth || points.length >= maxPoints - reserved - 1) {
      if (error > tolerance) capped = true;
      points.push(p[3]);
      return;
    }
    const a = mix(p[0], p[1]),
      b = mix(p[1], p[2]),
      c = mix(p[2], p[3]),
      d = mix(a, b),
      e = mix(b, c),
      f = mix(d, e);
    visit([p[0], a, d, f], depth + 1, reserved + 1);
    visit([f, e, c, p[3]], depth + 1, reserved);
  };
  for (let i = 0; i < segments; i++) {
    const a = curve.nodes[i],
      b = curve.nodes[(i + 1) % curve.nodes.length];
    visit([a.anchor, add(a.anchor, a.out), add(b.anchor, b.in), b.anchor], 0, segments - i - 1);
  }
  return { points, bounds: curveBounds(curve), capped };
}

const cross = (a: Vec2, b: Vec2, c: Vec2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

export function pointInRing(point: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j],
      b = ring[i];
    if (
      cross(a, b, point) === 0 &&
      point[0] >= Math.min(a[0], b[0]) &&
      point[0] <= Math.max(a[0], b[0]) &&
      point[1] >= Math.min(a[1], b[1]) &&
      point[1] <= Math.max(a[1], b[1])
    )
      return true;
    if (a[1] > point[1] !== b[1] > point[1] && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0])
      inside = !inside;
  }
  return inside;
}

const MAX_AREA_RING_POINTS = 2048;
const MAX_TRIANGULATION_DEVIATION = 1e-8;

/** Triangulate an already validated simple single ring. Return original vertex
 * indices and preserve its winding; holes/self-intersections remain unsupported.
 * Local coordinates avoid cancellation when a small region is far from origin. */
export function triangulateRing(ring: readonly Vec2[]): Uint32Array {
  if (ring.length < 3 || ring.length > MAX_AREA_RING_POINTS) throw new Error('invalid area ring size');
  const coordinates = new Float64Array(ring.length * 2);
  for (let index = 0; index < ring.length; index++) {
    coordinates[index * 2] = ring[index][0] - ring[0][0];
    coordinates[index * 2 + 1] = ring[index][1] - ring[0][1];
  }
  let area = 0;
  for (let index = 0; index < ring.length; index++) {
    const next = (index + 1) % ring.length;
    area += coordinates[index * 2] * coordinates[next * 2 + 1] - coordinates[next * 2] * coordinates[index * 2 + 1];
  }
  if (!Number.isFinite(area) || area === 0) throw new Error('degenerate area');
  const indices = earcut(coordinates);
  const error = deviation(coordinates, null, 2, indices);
  if (!indices.length || !Number.isFinite(error) || error > MAX_TRIANGULATION_DEVIATION)
    throw new Error('area cannot be triangulated');
  if (area < 0)
    for (let index = 0; index < indices.length; index += 3)
      [indices[index + 1], indices[index + 2]] = [indices[index + 2], indices[index + 1]];
  return new Uint32Array(indices);
}

/** XZ fill vertices relative to the first ring point, with original-index triangles. */
export function buildAreaFill(area: AreaFeature) {
  const origin: Vec3 = [area.ring[0][0], 0, area.ring[0][1]];
  return {
    origin,
    positions: new Float32Array(area.ring.flatMap((p) => [p[0] - origin[0], 0, p[1] - origin[2]])),
    indices: triangulateRing(area.ring),
  };
}

/** Extrude a validated XZ ring between absolute minY/maxY; indices cover each edge. */
export function buildAreaWall(area: AreaFeature) {
  const origin: Vec3 = [area.ring[0][0], area.minY, area.ring[0][1]],
    positions: number[] = [],
    indices: number[] = [];
  for (let i = 0; i < area.ring.length; i++) {
    const a = area.ring[i],
      b = area.ring[(i + 1) % area.ring.length],
      base = positions.length / 3;
    positions.push(
      a[0] - origin[0],
      0,
      a[1] - origin[2],
      b[0] - origin[0],
      0,
      b[1] - origin[2],
      b[0] - origin[0],
      area.maxY - area.minY,
      b[1] - origin[2],
      a[0] - origin[0],
      area.maxY - area.minY,
      a[1] - origin[2],
    );
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    origin,
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    bounds: boundsOf(
      area.ring.flatMap(
        (p) =>
          [
            [p[0], area.minY, p[1]],
            [p[0], area.maxY, p[1]],
          ] as Vec3[],
      ),
    ),
  };
}

export interface MaskLayout {
  origin: Vec2;
  size: Vec2;
  width: number;
  height: number;
  limited: boolean;
}

/** Allocate a bounded mask layout with a padded world-XZ extent. limited reports
 * when the requested world-units-per-CSS-pixel precision exceeds the texture cap. */
export function areaMaskLayout(bounds: { min: Vec2; max: Vec2 }, worldPerPixel: number, maxSize = 4096): MaskLayout {
  if (!(worldPerPixel > 0) || !Number.isFinite(worldPerPixel) || !Number.isSafeInteger(maxSize) || maxSize < 16)
    throw new Error('invalid mask resolution');
  const span: Vec2 = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]];
  if (![...bounds.min, ...bounds.max, ...span].every(Number.isFinite) || span.some((value) => value < 0))
    throw new Error('invalid mask bounds');
  const desired = worldPerPixel * 0.5;
  const step = Math.max(desired, ...span.map((v) => v / (maxSize - 4)));
  if (!(step > 0) || !Number.isFinite(step)) throw new Error('invalid mask resolution');
  const origin: Vec2 = [Math.floor(bounds.min[0] / step) * step - step, Math.floor(bounds.min[1] / step) * step - step];
  if (!origin.every(Number.isFinite)) throw new Error('mask origin exceeds numeric precision');
  const width = Math.max(4, Math.min(maxSize, Math.ceil((bounds.max[0] - origin[0]) / step) + 1)),
    height = Math.max(4, Math.min(maxSize, Math.ceil((bounds.max[1] - origin[1]) / step) + 1));
  return { origin, size: [width * step, height * step], width, height, limited: step > desired * 1.001 };
}

/** Map world XZ to normalized texture UVs, flipping the image-space vertical axis. */
export function areaMaskUv(point: Vec2, layout: MaskLayout): Vec2 {
  return [(point[0] - layout.origin[0]) / layout.size[0], 1 - (point[1] - layout.origin[1]) / layout.size[1]];
}

/** Conservative world bounds after scale and XYZ Euler rotations in radians.
 * Billboards use a pivot-centered sphere because orientation changes with camera. */
export function mediaBounds(feature: MediaFeature, version: MediaVersion): OverlayBounds {
  if (feature.placement === 'billboard') {
    const size = feature.size!,
      anchor = feature.anchor!;
    const radius = Math.hypot(
      size[0] * feature.scale[0] * Math.max(anchor[0], 1 - anchor[0]),
      size[1] * feature.scale[1] * Math.max(anchor[1], 1 - anchor[1]),
    );
    return boundsOf([feature.position], radius);
  }
  const source: Vec3[] = [];
  if (feature.placement === 'model') {
    if (!version.bounds) throw new Error('model has no bounds');
    for (let mask = 0; mask < 8; mask++)
      source.push([0, 1, 2].map((i) => (mask & (1 << i) ? version.bounds!.max[i] : version.bounds!.min[i])) as Vec3);
  } else {
    const [w, h] = feature.size!,
      [ax, ay] = feature.anchor!;
    for (const x of [-ax * w, (1 - ax) * w])
      for (const y of [-ay * h, (1 - ay) * h]) source.push(feature.placement === 'plane' ? [x, 0, -y] : [x, y, 0]);
  }
  // Euler XYZ, matching the viewer's instance transform, applied after intrinsic plane orientation.
  const [x, y, z] = feature.rotation,
    cx = Math.cos(x),
    sx = Math.sin(x),
    cy = Math.cos(y),
    sy = Math.sin(y),
    cz = Math.cos(z),
    sz = Math.sin(z);
  return boundsOf(
    source.map((point) => {
      let [a, b, c] = point.map((v, i) => v * feature.scale[i]);
      [a, b] = [a * cz - b * sz, a * sz + b * cz];
      [a, c] = [a * cy + c * sy, -a * sy + c * cy];
      [b, c] = [b * cx - c * sx, b * sx + c * cx];
      return [a + feature.position[0], b + feature.position[1], c + feature.position[2]];
    }),
  );
}
