/** Access may itself throw in restricted browsers, before getItem is called. */
export function browserStorage(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return globalThis[kind] ?? null;
  } catch {
    return null;
  }
}

export function readStored(storage: Pick<Storage, 'getItem'> | null, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
