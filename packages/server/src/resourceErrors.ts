import type { Context } from 'hono';
import { ResourceError } from '@violet-map/core/resources';
import { ContentValidationError } from '@violet-map/core/overlays';
import { ContentError } from './content.js';

/** Stable errors redact backend details without selecting another source or driver. */
export function resourceFailure(error: Error, c: Context) {
  if (error instanceof ContentError)
    return c.json({ code: error.code, message: error.message, retryable: error.status === 503 }, error.status);
  if (error instanceof ContentValidationError)
    return c.json(
      { code: error.code, message: error.message, retryable: false },
      error.code === 'UNSUPPORTED_FORMAT' ? 415 : 400,
    );
  if (error instanceof ResourceError) {
    const status =
      error.code === 'PUBLICATION_CONFLICT'
        ? 412
        : error.code === 'RESOURCE_BUSY' || error.code === 'RESOURCE_BACKEND_UNAVAILABLE'
          ? 503
          : error.code === 'UNSUPPORTED_RESOURCE_FORMAT'
            ? 415
            : 409;
    if (status === 503) c.header('retry-after', '1');
    return c.json({ code: error.code, message: error.message, retryable: error.retryable }, status);
  }
  if (error instanceof TypeError || error instanceof RangeError)
    return c.json({ code: 'INVALID_INPUT', message: error.message, retryable: false }, 400);
  return c.json(
    { code: 'RESOURCE_BACKEND_UNAVAILABLE', message: 'resource backend is unavailable', retryable: true },
    503,
  );
}
