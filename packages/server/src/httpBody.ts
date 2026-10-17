import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { readLimitedBody } from '@violet-map/core/http';

/** Read one bounded JSON document. Callers still validate its business schema;
 * malformed/oversized input is rejected before invoking storage or services. */
export async function readRequestJson(context: Context, maxBytes: number): Promise<unknown> {
  const bytes = await readLimitedBody(context.req.raw, maxBytes);
  if (!bytes) throw new HTTPException(413, { res: context.json({ error: 'request body too large' }, 413) });
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HTTPException(400, { res: context.json({ error: 'invalid JSON' }, 400) });
  }
}
