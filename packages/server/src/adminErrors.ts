import type { Context } from 'hono';
import { AdminError } from './errors.js';
import { RequestBodyError } from './httpBody.js';

const statuses = { USER_NOT_FOUND: 404, USER_EXISTS: 409, FORBIDDEN: 403, INVALID_INPUT: 400 } as const;

export function adminFailure(error: Error, c: Context) {
  if (error instanceof RequestBodyError) {
    if (error.reason === 'too-large') return error.getResponse();
    return c.json({ code: 'INVALID_INPUT', error: error.message }, 400);
  }
  if (error instanceof AdminError) return c.json({ code: error.code, error: error.message }, statuses[error.code]);
  return c.json({ code: 'INTERNAL_ERROR', error: 'management operation failed' }, 500);
}
