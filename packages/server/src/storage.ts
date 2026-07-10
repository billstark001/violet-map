import { CachedWorldStorage, createWorldStorage, type WorldStorage } from '@violet-map/core/storage';
import { config } from './config.js';

export { cleanStoragePath, type StoredFileInfo, type WorldStorage } from '@violet-map/core/storage';

/** Server-owned storage configuration, implemented by the shared core adapter. */
function configuredStorage(): WorldStorage {
  const storage = config.worldStorage !== 's3'
    ? createWorldStorage({ kind: 'local', root: config.worldsDir })
    : (() => {
      if (!config.s3.bucket) throw new Error('S3_BUCKET is required when WORLD_STORAGE=s3');
      return createWorldStorage({ kind: 's3', ...config.s3, bucket: config.s3.bucket });
    })();
  return new CachedWorldStorage(storage, { statTtlMs: 1_000, listTtlMs: 2_000 });
}

export const worldStorage = configuredStorage();
