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

/** Validate a batch while retaining the request's order and historical size cap. */
export function parseChunkCoordinates(raw: unknown, limit: number): ChunkCoordinate[] | null {
  if (!raw || typeof raw !== 'object' || !('chunks' in raw)) return null;
  const chunks = (raw as { chunks: unknown }).chunks;
  if (!Array.isArray(chunks)) return null;
  const result: ChunkCoordinate[] = [];
  for (const value of chunks.slice(0, limit)) {
    if (!value || typeof value !== 'object' || !isChunkCoordinate(value.cx) || !isChunkCoordinate(value.cz)) {
      return null;
    }
    result.push({ cx: value.cx, cz: value.cz });
  }
  return result;
}
