import type { ViewState } from '../view/state';
import { TOP_MAP_MAX_RADIUS_BLOCKS } from './topMapPolicy';
import { TOP_MAP_TILE_BLOCKS } from '@violet-map/core/formats/top-map';
import type { RegionCoordinate } from '../view/topMapCoverage';

export interface RegionBounds {
  minRx: number;
  maxRx: number;
  minRz: number;
  maxRz: number;
}

/** Enumerate visible regions using the smaller of the view grid and manifest. */
function* candidateRegionCoords(
  regions: ReadonlyMap<string, RegionCoordinate>,
  bounds: RegionBounds,
): Generator<RegionCoordinate> {
  const width = bounds.maxRx - bounds.minRx + 1;
  const height = bounds.maxRz - bounds.minRz + 1;
  if (width <= 0 || height <= 0) return;
  if (width * height <= regions.size) {
    for (let rz = bounds.minRz; rz <= bounds.maxRz; rz++) {
      for (let rx = bounds.minRx; rx <= bounds.maxRx; rx++) {
        const region = regions.get(`${rx},${rz}`);
        if (region) yield region;
      }
    }
    return;
  }
  for (const region of regions.values()) {
    if (
      region.rx >= bounds.minRx &&
      region.rx <= bounds.maxRx &&
      region.rz >= bounds.minRz &&
      region.rz <= bounds.maxRz
    )
      yield region;
  }
}

export interface TopMapPlanInput {
  bounds: RegionBounds;
  cameraX: number;
  cameraZ: number;
  maxDistanceBlocks?: number;
  limit: number;
  mode: 'perspective' | 'top';
  zoom: number;
}

/** Geometry-independent demand: clipped, ranked and bounded before any IO or GPU allocation. */
export function planTopMapTiles(regions: ReadonlyMap<string, RegionCoordinate>, input: TopMapPlanInput) {
  const maxDistance = Number.isFinite(input.maxDistanceBlocks) ? Math.max(0, input.maxDistanceBlocks!) : Infinity;
  const halfDiagonal = (TOP_MAP_TILE_BLOCKS * Math.SQRT2) / 2;
  const candidates = [];
  for (const region of candidateRegionCoords(regions, input.bounds)) {
    const x = region.rx * TOP_MAP_TILE_BLOCKS + TOP_MAP_TILE_BLOCKS / 2;
    const z = region.rz * TOP_MAP_TILE_BLOCKS + TOP_MAP_TILE_BLOCKS / 2;
    const distance = Math.hypot(x - input.cameraX, z - input.cameraZ);
    if (distance + halfDiagonal > maxDistance) continue;
    candidates.push({ ...region, distance, step: topMapLodStep(distance, input.mode, input.zoom) });
  }
  candidates.sort((a, b) => a.distance - b.distance || a.rx - b.rx || a.rz - b.rz);
  return candidates.slice(0, Math.max(0, Math.floor(input.limit)));
}

export function topMapLodStep(distance: number, mode: TopMapPlanInput['mode'], zoom: number): number {
  if (mode === 'perspective') return distance <= 32 * 16 ? 2 : distance <= 128 * 16 ? 4 : 8;
  return zoom >= 2.25 ? 2 : zoom >= 1.15 ? 4 : 8;
}

export function topMapViewMetrics(view: ViewState): { width: number; height: number; zoom: number } {
  if (view.mode === 'perspective')
    return { width: TOP_MAP_MAX_RADIUS_BLOCKS * 2, height: TOP_MAP_MAX_RADIUS_BLOCKS * 2, zoom: 1 };
  const projection = view.projection;
  if (projection.kind === 'orthographic') {
    const height = (projection.top - projection.bottom) / projection.zoom;
    return { width: (projection.right - projection.left) / projection.zoom, height, zoom: projection.zoom };
  }
  const height = (2 * Math.max(1, view.position.y) * Math.tan(projection.fovYRadians * 0.5)) / projection.zoom;
  return { width: height * projection.aspect, height, zoom: TOP_MAP_TILE_BLOCKS / Math.max(1, height) };
}
