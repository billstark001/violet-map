import * as pako from 'pako';
import { isRegionCoordinate } from './chunkCoordinate.js';

const REGION_HEADER_BYTES = 8192;
const REGION_SECTOR_BYTES = 4096;
const REGION_SIDE_CHUNKS = 32;

const REGION_FILE_NAME = /^r\.(-?\d+)\.(-?\d+)\.mca$/;

/** Parse an Anvil basename within the signed-int chunk coordinate space. */
export function parseRegionFileName(name: string): { x: number; z: number } | null {
  const match = REGION_FILE_NAME.exec(name);
  if (!match) return null;
  const x = Number(match[1]),
    z = Number(match[2]);
  return isRegionCoordinate(x) && isRegionCoordinate(z) ? { x, z } : null;
}

export interface RegionChunkRecord {
  /** Anvil compression id: gzip, zlib or uncompressed NBT. */
  compression: 1 | 2 | 3;
  /** Borrowed view into the region; copy it before retaining beyond the region's lifetime. */
  payload: Uint8Array;
}

/**
 * Locate a validated Anvil record without decoding it, allowing platform-native
 * codecs to share the same sector, length and compression validation.
 * Returns null when its location is absent or its declared record extends outside its sectors.
 * Unknown compression types throw; the payload itself has not been validated.
 */
export function getRegionChunkRecord(region: Uint8Array, localX: number, localZ: number): RegionChunkRecord | null {
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
  if (compression !== 1 && compression !== 2 && compression !== 3)
    throw new Error(`Unknown region compression type ${compression}`);
  const payload = region.subarray(base + 5, base + 4 + length);
  return { compression, payload };
}

/** Return owned decompressed NBT, or null for an absent/truncated Anvil record.
 * Unsupported compression and invalid compressed data throw. */
export function getRegionChunk(region: Uint8Array, localX: number, localZ: number): Uint8Array | null {
  const record = getRegionChunkRecord(region, localX, localZ);
  if (!record) return null;
  switch (record.compression) {
    case 1:
      return pako.ungzip(record.payload);
    case 2:
      return pako.inflate(record.payload);
    case 3:
      return record.payload.slice();
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
