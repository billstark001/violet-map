/** Reject traversal and normalize every storage path to a forward-slash relative path. */
export function cleanStoragePath(input: string): string {
  const raw = input.replace(/\\/g, '/').replace(/^\/+/, '');
  if (raw.split('/').includes('..')) throw new Error('invalid storage path');
  const normalized = raw
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/');
  if (!normalized || normalized === '.') return '';
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error('invalid storage path');
  }
  return normalized;
}

export function joinStoragePath(...parts: string[]): string {
  return cleanStoragePath(parts.filter(Boolean).join('/'));
}
