import { isDimensionId, isWorldName } from '@violet-map/core/domain';
import type { MiddlewareHandler } from 'hono';

export const validateWorldName: MiddlewareHandler = async (context, next) => {
  if (!isWorldName(context.req.param('world'))) return context.json({ error: 'invalid world name' }, 400);
  await next();
};

export function isWorldCreateInput(
  value: unknown,
): value is { world?: unknown; levelName?: string; dimensions?: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as { levelName?: unknown; dimensions?: unknown };
  return (
    (input.levelName === undefined || typeof input.levelName === 'string') &&
    (input.dimensions === undefined || (Array.isArray(input.dimensions) && input.dimensions.every(isDimensionId)))
  );
}
