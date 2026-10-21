import type { AtomicObjectStorage, ObjectReader, ObjectStorage } from '@violet-map/core/storage';

/** Explicit optional capabilities; callers select them before performing I/O. */
export interface ObjectHttpMetadata {
  contentType: string;
  cacheControl?: string;
  digest?: string;
}

export interface ConditionalObjectWriter {
  /** The complete object becomes visible atomically. False means it already exists. */
  create(filePath: string, bytes: Uint8Array, metadata: ObjectHttpMetadata): Promise<boolean>;
}

export interface ConditionalDocumentStore {
  /** Opaque token is valid only for this object and backend. */
  readDocument(filePath: string, maxBytes?: number): Promise<{ bytes: Uint8Array; token: string } | null>;
  compareExchange(filePath: string, expectedToken: string | null, bytes: Uint8Array): Promise<boolean>;
}

export interface ObjectScanner {
  scan(prefix?: string): AsyncIterable<import('@violet-map/core/storage').StoredFileInfo>;
}

export interface ObjectCapabilities extends ConditionalObjectWriter, ConditionalDocumentStore, ObjectScanner {
  replace: AtomicObjectStorage['replace'];
}

/** Physical storage required for publication authority and persistent caches. */
export type TransactionalObjectStorage = ObjectStorage & ObjectCapabilities;

/** Select supported capabilities before I/O rather than asserting backend types. */
export function requireStorageCapabilities<T extends ObjectReader, K extends keyof ObjectCapabilities>(
  storage: T,
  ...names: K[]
): T & Pick<ObjectCapabilities, K> {
  for (const name of names)
    if (!(name in storage) || typeof (storage as T & Partial<ObjectCapabilities>)[name] !== 'function')
      throw new TypeError(`storage does not support ${name}`);
  return storage as T & Pick<ObjectCapabilities, K>;
}
