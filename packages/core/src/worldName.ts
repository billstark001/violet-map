const WORLD_NAME_RE = /^[A-Za-z0-9_.-]+$/;

/** A single world directory name; dot segments would collapse a mount boundary. */
export function isWorldName(value: unknown): value is string {
  return typeof value === 'string' && value !== '.' && value !== '..' && WORLD_NAME_RE.test(value);
}

export function assertWorldName(value: string): void {
  if (!isWorldName(value)) throw new Error('invalid world name');
}
