import type { Context } from 'hono';
import { ResourceError } from '@violet-map/core/resources';
import { ContentValidationError } from '@violet-map/core/overlays';
import { resourceFailure } from './resourceErrors.js';
import { ContentError } from './content.js';
import { RequestBodyError } from './httpBody.js';

/** Public content endpoints share one error policy in source and publication modes. */
export function contentFailure(error: Error, c: Context) {
  if (error instanceof RequestBodyError)
    return c.json(
      { code: error.reason === 'too-large' ? 'PAYLOAD_TOO_LARGE' : 'INVALID_CONTENT', error: error.message },
      error.status,
    );
  if (error instanceof ResourceError) return resourceFailure(error, c);
  if (error instanceof ContentValidationError)
    return c.json({ code: error.code, error: error.message }, error.code === 'UNSUPPORTED_FORMAT' ? 415 : 400);
  if (error instanceof ContentError) {
    if (error.code === 'CONTENT_BUSY') c.header('retry-after', '1');
    return c.json({ code: error.code, error: error.message }, error.status);
  }
  // Backend errors may include endpoint URLs and credentials. Never reflect them.
  return c.json({ code: 'CONTENT_BACKEND_UNAVAILABLE', error: 'content backend is unavailable' }, 503);
}
