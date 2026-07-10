import { LocalWorldStorage } from './local.js';
import { S3WorldStorage } from './s3.js';
import { ServerWorldStorage } from './server.js';
import type { StorageOptions, WorldStorage } from './types.js';

export * from './types.js';
export * from './paths.js';
export * from './local.js';
export * from './s3.js';
export * from './server.js';
export * from './prefixed.js';
export * from './cached.js';
export * from './sync.js';

export function createWorldStorage(options: StorageOptions): WorldStorage {
  switch (options.kind) {
    case 'local': return new LocalWorldStorage(options.root);
    case 's3': return new S3WorldStorage(options);
    case 'server': return new ServerWorldStorage(options);
  }
}
