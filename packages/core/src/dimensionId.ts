const NAMESPACE_RE = /^[a-z0-9_.-]+$/;
const PATH_SEGMENT_RE = /^[a-z0-9_.-]+$/;

/** Accept Minecraft-style IDs, including custom dimension paths with `/`. */
export function isDimensionId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  if (parts.length > 2) return false;
  const [namespace, resourcePath] = parts.length === 2 ? parts : ['minecraft', parts[0]];
  return (
    NAMESPACE_RE.test(namespace) &&
    resourcePath.split('/').every((segment) => PATH_SEGMENT_RE.test(segment) && segment !== '.' && segment !== '..')
  );
}

export function assertDimensionId(value: string): void {
  if (!isDimensionId(value)) throw new Error('invalid dimension id');
}
