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

/** Locate the sector span using only the location header. */
export function regionChunkRange(
  header: Uint8Array,
  localX: number,
  localZ: number,
): { start: number; length: number } | null {
  if (
    header.length < REGION_SECTOR_BYTES ||
    !Number.isInteger(localX) ||
    !Number.isInteger(localZ) ||
    localX < 0 ||
    localX >= REGION_SIDE_CHUNKS ||
    localZ < 0 ||
    localZ >= REGION_SIDE_CHUNKS
  )
    return null;
  const loc = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(
    (localX + localZ * REGION_SIDE_CHUNKS) * 4,
  );
  const offset = loc >>> 8;
  const sectors = loc & 0xff;
  return offset >= 2 && sectors > 0
    ? { start: offset * REGION_SECTOR_BYTES, length: sectors * REGION_SECTOR_BYTES }
    : null;
}

/** Validate a record span, including its declared sector bound, without decoding NBT. */
export function parseRegionChunkRecord(bytes: Uint8Array, sectorBytes: number): RegionChunkRecord | null {
  if (bytes.length < 5) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(0);
  if (length < 1 || length > sectorBytes - 4 || 4 + length > bytes.length) return null;
  const compression = bytes[4];
  if (compression !== 1 && compression !== 2 && compression !== 3)
    throw new Error(`Unknown region compression type ${compression}`);
  return { compression, payload: bytes.subarray(5, 4 + length) };
}

/**
 * Locate a validated Anvil record without decoding it, allowing platform-native
 * codecs to share the same sector, length and compression validation.
 * Returns null when its location is absent or its declared record extends outside its sectors.
 * Unknown compression types throw; the payload itself has not been validated.
 */
export function getRegionChunkRecord(region: Uint8Array, localX: number, localZ: number): RegionChunkRecord | null {
  if (region.length < REGION_HEADER_BYTES) return null;
  const range = regionChunkRange(region, localX, localZ);
  return range ? parseRegionChunkRecord(region.subarray(range.start, range.start + range.length), range.length) : null;
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
