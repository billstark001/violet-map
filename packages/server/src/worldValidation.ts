import { cleanStoragePath } from '@violet-map/storage';
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

/** Validate a sync manifest before remote hashing starts; unknown metadata is retained. */
export function isWorldDiffInput(
  value: unknown,
): value is { files?: { path: string; hash?: string; size?: number }[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const files = (value as { files?: unknown }).files;
  if (files === undefined) return true;
  if (!Array.isArray(files)) return false;
  return files.every((file) => {
    if (
      !file ||
      typeof file !== 'object' ||
      typeof file.path !== 'string' ||
      (file.hash !== undefined && typeof file.hash !== 'string') ||
      (file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size < 0))
    )
      return false;
    try {
      return cleanStoragePath(file.path).length > 0;
    } catch {
      return false;
    }
  });
}
