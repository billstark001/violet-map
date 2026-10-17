import type { ObjectStorage } from '@violet-map/core/storage';
import type { StorageOptions } from '@violet-map/storage/types';
/** @deprecated For physical backends use createObjectStorage. Remote world protocol remains supported. */
export async function createWorldStorage(options: StorageOptions): Promise<ObjectStorage> {
  if (options.kind === 'server') return new (await import('./server.js')).ServerWorldStorage(options);
  return createObjectStorage(options);
}

/** Physical object backend factory. Remote world protocol is intentionally excluded. */
export async function createObjectStorage(
  options: Exclude<StorageOptions, { kind: 'server' }>,
): Promise<import('@violet-map/core/storage').AtomicObjectStorage> {
  switch (options.kind) {
    case 'local':
      return new (await import('./local.js')).LocalStorage(options.root);
    case 's3':
      return new (await import('./s3.js')).S3Storage(options);
  }
}
