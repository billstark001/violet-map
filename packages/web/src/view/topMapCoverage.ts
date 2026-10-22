import { TOP_MAP_TILE_BLOCKS } from '@violet-map/core/formats/top-map';

const TOP_MAP_CHUNKS_PER_AXIS = TOP_MAP_TILE_BLOCKS / 16;
const TOP_MAP_CHUNK_MASK_BYTES = (TOP_MAP_CHUNKS_PER_AXIS * TOP_MAP_CHUNKS_PER_AXIS) / 8;

export interface TileCoverage {
  key: string;
  mask: Uint8Array;
}

export function buildTileCoverage(onlineChunks: ReadonlySet<string> | undefined): Map<string, TileCoverage> {
  const masks = new Map<string, Uint8Array>();
  if (!onlineChunks?.size) return new Map();
  for (const chunkKey of onlineChunks) {
    const separator = chunkKey.indexOf(',');
    if (separator < 1) continue;
    const cx = Number(chunkKey.slice(0, separator));
    const cz = Number(chunkKey.slice(separator + 1));
    if (!Number.isInteger(cx) || !Number.isInteger(cz)) continue;
    const rx = Math.floor(cx / TOP_MAP_CHUNKS_PER_AXIS);
    const rz = Math.floor(cz / TOP_MAP_CHUNKS_PER_AXIS);
    const tileKey = `${rx},${rz}`;
    let mask = masks.get(tileKey);
    if (!mask) {
      mask = new Uint8Array(TOP_MAP_CHUNK_MASK_BYTES);
      masks.set(tileKey, mask);
    }
    const localX = cx - rx * TOP_MAP_CHUNKS_PER_AXIS;
    const localZ = cz - rz * TOP_MAP_CHUNKS_PER_AXIS;
    const index = localZ * TOP_MAP_CHUNKS_PER_AXIS + localX;
    mask[index >> 3] |= 1 << (index & 7);
  }
  const coverage = new Map<string, TileCoverage>();
  for (const [key, mask] of masks) coverage.set(key, { key: topMapCoverageKeyFromMask(mask), mask });
  return coverage;
}

function topMapCoverageKeyFromMask(mask: Uint8Array | undefined): string {
  if (!mask?.byteLength) return '';
  const parts: string[] = [];
  let covered = 0;
  const byteLength = Math.min(mask.byteLength, TOP_MAP_CHUNK_MASK_BYTES);
  for (let byteIndex = 0; byteIndex < byteLength; byteIndex++) {
    let bits = mask[byteIndex];
    if (!bits) continue;
    for (let bit = 0; bit < 8; bit++) {
      if ((bits & (1 << bit)) === 0) continue;
      covered++;
      parts.push((byteIndex * 8 + bit).toString(36));
    }
  }
  return covered === TOP_MAP_CHUNKS_PER_AXIS * TOP_MAP_CHUNKS_PER_AXIS ? '*' : parts.join('.');
}
