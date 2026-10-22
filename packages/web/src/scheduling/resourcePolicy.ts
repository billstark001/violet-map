import { ResourceError } from '@violet-map/core/resources';

export const RESOURCE_LOAD_TIMEOUT_MS = 30_000;

/** Retry the selected resource only; malformed or unverified data is terminal. */
export function resourceLoadRetryable(error: unknown): boolean {
  return error instanceof ResourceError && error.retryable;
}

export function resourceLoadRetryDelayMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new RangeError('invalid resource retry attempt');
  return 250 * 2 ** Math.min(attempt, 4);
}
