/** Metadata shared by local, S3, and remote object storage backends. */
export interface StoredFileInfo {
  path: string;
  size: number;
  modifiedAt?: number;
  etag?: string;
}

/**
 * A flat, path-safe object store for immutable bytes and application documents.
 * Paths are relative to the configured root and use `/` separators.
 * Missing files return null; backend failures reject instead.
 */
export interface ObjectReader {
  readonly kind: 'local' | 's3' | 'server';
  read(filePath: string): Promise<Uint8Array | null>;
  /** Read at most length bytes from start; an offset at or beyond EOF returns an empty array. */
  readRange(filePath: string, start: number, length: number): Promise<Uint8Array | null>;
  stat(filePath: string): Promise<StoredFileInfo | null>;
  /** List directory descendants (not a same-name object). Empty prefix lists all objects. Sorted by relative path. */
  list(prefix?: string): Promise<StoredFileInfo[]>;
  /** List immediate child directory names below a path prefix. */
  listDirectories(prefix?: string): Promise<string[]>;
}

export interface ObjectStorage extends ObjectReader {
  write(filePath: string, bytes: Uint8Array, contentType?: string): Promise<void>;
  delete(filePath: string): Promise<void>;
  /** Delete directory descendants, excluding a same-name object and sibling prefixes. */
  deletePrefix(prefix: string): Promise<number>;
}

/** Atomic visibility of a single object, not a transaction or compare-and-swap. */
export interface AtomicObjectStorage extends ObjectStorage {
  replace(filePath: string, bytes: Uint8Array, contentType?: string): Promise<void>;
}
