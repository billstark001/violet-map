import * as pako from 'pako';

const REGION_HEADER_BYTES = 8192;
const REGION_SECTOR_BYTES = 4096;
const REGION_SIDE_CHUNKS = 32;

/**
 * Return a chunk's decompressed NBT from an Anvil `.mca` region, or null when
 * its location is absent or its declared record extends outside its sectors.
 * Unknown compression types and invalid compressed payloads throw.
 */
export function getRegionChunk(region: Uint8Array, localX: number, localZ: number): Uint8Array | null {
  if (
    region.length < REGION_HEADER_BYTES ||
    !Number.isInteger(localX) ||
    !Number.isInteger(localZ) ||
    localX < 0 ||
    localX >= REGION_SIDE_CHUNKS ||
    localZ < 0 ||
    localZ >= REGION_SIDE_CHUNKS
  )
    return null;
  const view = new DataView(region.buffer, region.byteOffset, region.byteLength);
  const idx = localX + localZ * REGION_SIDE_CHUNKS;
  const loc = view.getUint32(idx * 4);
  const sectorOffset = loc >>> 8;
  const sectorCount = loc & 0xff;
  if (sectorOffset < 2 || sectorCount === 0) return null;
  const base = sectorOffset * REGION_SECTOR_BYTES;
  if (base + 5 > region.length) return null;
  const length = view.getUint32(base);
  if (length < 1 || length > sectorCount * REGION_SECTOR_BYTES - 4 || base + 4 + length > region.length) {
    return null;
  }
  const compression = view.getUint8(base + 4);
  const payload = region.subarray(base + 5, base + 4 + length);
  switch (compression) {
    case 1:
      return pako.ungzip(payload);
    case 2:
      return pako.inflate(payload);
    case 3:
      return payload.slice();
    default:
      throw new Error(`Unknown region compression type ${compression}`);
  }
}

export function* iterateRegionChunks(
  region: Uint8Array,
): Generator<{ localX: number; localZ: number; data: Uint8Array }> {
  for (let z = 0; z < REGION_SIDE_CHUNKS; z++) {
    for (let x = 0; x < REGION_SIDE_CHUNKS; x++) {
      const data = getRegionChunk(region, x, z);
      if (data) yield { localX: x, localZ: z, data };
    }
  }
}
