import path from 'node:path';

/** Reject traversal and normalize every storage path to a forward-slash relative path. */
export function cleanStoragePath(input: string): string {
  const raw = input.replace(/\\/g, '/').replace(/^\/+/, '');
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === '.') return '';
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new Error('invalid storage path');
  }
  return normalized;
}

export function joinStoragePath(...parts: string[]): string {
  return cleanStoragePath(parts.filter(Boolean).join('/'));
}
