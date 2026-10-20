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
