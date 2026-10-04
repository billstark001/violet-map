export interface RegionCoordinate {
  rx: number;
  rz: number;
  key: string;
}

export interface RegionBounds {
  minRx: number;
  maxRx: number;
  minRz: number;
  maxRz: number;
}

/** Enumerate visible regions using the smaller of the view grid and manifest. */
export function* candidateRegionCoords(
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
