export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3StorageOptions {
  bucket: string;
  prefix?: string;
  endpoint?: string;
  region?: string;
  credentials?: S3Credentials | (() => Promise<S3Credentials>);
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
