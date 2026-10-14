import { WorkLimiter } from '@violet-map/core/async';

export class ChunkServiceBusyError extends Error {}

/** Bounds concurrent chunk reads while preserving the route's busy error. */
export class ChunkReadLimiter extends WorkLimiter {
  constructor(maxConcurrent: number, maxQueued: number) {
    super(maxConcurrent, maxQueued, () => new ChunkServiceBusyError('chunk service is busy'));
  }
}
