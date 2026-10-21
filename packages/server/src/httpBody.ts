import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { readLimitedBody } from '@violet-map/core/http';

/** Route error handlers can translate this into their public error envelope. */
export class RequestBodyError extends HTTPException {
  constructor(
    context: Context,
    readonly reason: 'too-large' | 'invalid-json',
  ) {
    const status = reason === 'too-large' ? 413 : 400;
    const message = reason === 'too-large' ? 'request body too large' : 'invalid JSON';
    super(status, { message, res: context.json({ error: message }, status) });
  }
}

/** Read one bounded JSON document. Callers still validate its business schema;
 * malformed/oversized input is rejected before invoking storage or services. */
export async function readRequestJson(
  context: Context,
  maxBytes: number,
  options: { allowEmpty?: boolean } = {},
): Promise<unknown> {
  const bytes = await readLimitedBody(context.req.raw, maxBytes);
  if (!bytes) throw new RequestBodyError(context, 'too-large');
  const text = new TextDecoder().decode(bytes);
  if (options.allowEmpty && !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestBodyError(context, 'invalid-json');
  }
}
