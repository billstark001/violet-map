import type { WorldStorage } from '@violet-map/core/storage';
import type { StorageOptions } from '@violet-map/storage/types';
export async function createWorldStorage(options: StorageOptions): Promise<WorldStorage> {
  switch (options.kind) {
    case 'local':
      return new (await import('./local.js')).LocalWorldStorage(options.root);
    case 's3':
      return new (await import('./s3.js')).S3WorldStorage(options);
    case 'server':
      return new (await import('./server.js')).ServerWorldStorage(options);
  }
}
