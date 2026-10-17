import { isChunkCoordinate, type ChunkCoordinate } from '@violet-map/core/domain';

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
