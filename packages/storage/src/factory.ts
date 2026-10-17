import type { StorageOptions } from '@violet-map/storage/types';

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
