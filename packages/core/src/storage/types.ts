/** Metadata shared by local, S3, and remote world storage backends. */
export interface StoredFileInfo {
  path: string;
  size: number;
  modifiedAt?: number;
  etag?: string;
}

/** A flat, path-safe object store used to hold Minecraft world files. */
export interface WorldStorage {
  readonly kind: 'local' | 's3' | 'server';
  read(filePath: string): Promise<Uint8Array | null>;
  readRange(filePath: string, start: number, length: number): Promise<Uint8Array | null>;
  write(filePath: string, bytes: Uint8Array, contentType?: string): Promise<void>;
  delete(filePath: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
  stat(filePath: string): Promise<StoredFileInfo | null>;
  list(prefix?: string): Promise<StoredFileInfo[]>;
  listDirectories(prefix?: string): Promise<string[]>;
}

export interface S3StorageOptions {
  bucket: string;
  prefix?: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

export interface ServerStorageOptions {
  /** Violet Map server origin, for example https://map.example.com. */
  url: string;
  /** A root, admin, or CI credential issued by that server. */
  token: string;
}

export type StorageOptions =
  | { kind: 'local'; root: string }
  | ({ kind: 's3' } & S3StorageOptions)
  | ({ kind: 'server' } & ServerStorageOptions);
