import { CachedWorldStorage } from '@violet-map/storage';
import { createWorldStorage } from '@violet-map/storage/factory';
import type { ServerConfig } from './configuration.js';
export async function createStorage(config: ServerConfig) {
  const storage = await createWorldStorage(
    config.storage.driver === 'local'
      ? { kind: 'local', root: config.storage.worldsDir }
      : { kind: 's3', ...config.storage.s3, bucket: config.storage.s3.bucket! },
  );
  return new CachedWorldStorage(storage, {
    statTtlMs: config.cache.storageStatMs,
    listTtlMs: config.cache.storageListMs,
  });
}
