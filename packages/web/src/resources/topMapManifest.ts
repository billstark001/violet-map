import { parseArtifactRef, ResourceError, type ArtifactRef } from '@violet-map/core/resources';
import type { RegionCoordinate } from '../view/topMapCoverage';

export interface TopMapSourceRegion extends RegionCoordinate {
  artifact: ArtifactRef;
}

function invalid(): never {
  throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'invalid top map manifest');
}

/** Decode only current, identity-bound artifact references. Missing Top Maps
 * are explicit; malformed manifests never become an empty available region set.
 */
export function decodeTopMapManifest(
  value: unknown,
  world: string,
  dimension: string,
): ReadonlyMap<string, TopMapSourceRegion> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const manifest = value as Record<string, unknown>;
  if (manifest.world !== world || manifest.dimension !== dimension || typeof manifest.hasTopMap !== 'boolean')
    return invalid();
  const regions = new Map<string, TopMapSourceRegion>();
  if (!manifest.hasTopMap) return regions;
  const topMap = manifest.topMap as { regions?: unknown } | null;
  if (!topMap || !Array.isArray(topMap.regions) || topMap.regions.length === 0) return invalid();
  for (const value of topMap.regions) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    const region = value as Record<string, unknown>;
    if (
      typeof region.x !== 'number' ||
      !Number.isSafeInteger(region.x) ||
      typeof region.z !== 'number' ||
      !Number.isSafeInteger(region.z)
    )
      return invalid();
    const key = `${region.x},${region.z}`;
    if (regions.has(key)) return invalid();
    let artifact: ArtifactRef;
    try {
      artifact = parseArtifactRef(region.artifact);
    } catch {
      return invalid();
    }
    if (artifact.format !== 'topmap-msgpack-v6' || artifact.mediaType !== 'application/msgpack') return invalid();
    regions.set(key, { key, rx: region.x, rz: region.z, artifact });
  }
  return regions;
}
