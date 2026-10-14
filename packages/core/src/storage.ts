/** Metadata shared by local, S3, and remote world storage backends. */
export interface StoredFileInfo {
  path: string;
  size: number;
  modifiedAt?: number;
  etag?: string;
}

/**
 * A flat, path-safe object store used to hold Minecraft world files.
 * Paths are relative to the configured root and use `/` separators.
 * Missing files return null; backend failures reject instead.
 */
export interface WorldReader {
  readonly kind: 'local' | 's3' | 'server';
  read(filePath: string): Promise<Uint8Array | null>;
  /** Read at most length bytes from start; an offset at or beyond EOF returns an empty array. */
  readRange(filePath: string, start: number, length: number): Promise<Uint8Array | null>;
  stat(filePath: string): Promise<StoredFileInfo | null>;
  /** Recursively list files below a path prefix, sorted by their relative paths. */
  list(prefix?: string): Promise<StoredFileInfo[]>;
  /** List immediate child directory names below a path prefix. */
  listDirectories(prefix?: string): Promise<string[]>;
}

export interface WorldStorage extends WorldReader {
  write(filePath: string, bytes: Uint8Array, contentType?: string): Promise<void>;
  delete(filePath: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
}
