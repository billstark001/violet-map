const MIN_CHUNK_COORD = -0x80000000;
const MAX_CHUNK_COORD = 0x7fffffff;

export interface ChunkCoordinate {
  cx: number;
  cz: number;
}

/** Chunk coordinates are signed 32-bit integers in Java chunk NBT and region math. */
export function isChunkCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_CHUNK_COORD && value <= MAX_CHUNK_COORD;
}
