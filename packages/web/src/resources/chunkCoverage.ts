import { ResourceError } from '@violet-map/core/resources';

export interface ChunkSourceCoverage {
  regions: ReadonlyMap<string, Uint8Array>;
  chunks: ReadonlySet<string>;
}

function invalid(): never {
  throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'invalid chunk source coverage');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function coordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Region masks are required protocol data, never a hint to infer source holes.
 * Reject the whole projection instead of treating a malformed region as absent.
 */
export function decodeChunkCoverage(value: unknown): ChunkSourceCoverage {
  const payload = record(value);
  if (!Array.isArray(payload.regions) || !Array.isArray(payload.chunks)) return invalid();
  const regions = new Map<string, Uint8Array>();
  const chunks = new Set<string>();
  for (const item of payload.regions) {
    const region = record(item);
    if (!coordinate(region.x) || !coordinate(region.z)) return invalid();
    const key = `${region.x},${region.z}`;
    if (regions.has(key) || typeof region.mask !== 'string' || !/^[A-Za-z0-9+/]{171}=$/.test(region.mask))
      return invalid();
    let bytes: string;
    try {
      bytes = atob(region.mask);
    } catch {
      return invalid();
    }
    if (bytes.length !== 128) return invalid();
    regions.set(
      key,
      Uint8Array.from(bytes, (byte) => byte.charCodeAt(0)),
    );
  }
  for (const item of payload.chunks) {
    const chunk = record(item);
    if (!coordinate(chunk.cx) || !coordinate(chunk.cz)) return invalid();
    chunks.add(`${chunk.cx},${chunk.cz}`);
  }
  return { regions, chunks };
}
