import { CachedStorage, ScopedStorage } from '@violet-map/storage';
import { createObjectStorage } from '@violet-map/storage/factory';
import type { AtomicObjectStorage } from '@violet-map/core/storage';
import type { ServerConfig } from './configuration.js';

export async function createStorageMounts(config: ServerConfig) {
  const physical = new Map<string, AtomicObjectStorage>();
  const mount = async (name: 'worlds' | 'content' | 'blobs') => {
    const { backend: id, prefix } = config.storage.mounts[name];
    let backend = physical.get(id);
    if (!backend) {
      const definition = config.storage.backends[id];
      backend = await createObjectStorage(
        definition.driver === 'local' ? { kind: 'local', root: definition.root } : { ...definition, kind: 's3' },
      );
      physical.set(id, backend);
    }
    return new CachedStorage(new ScopedStorage(backend, prefix), {
      statTtlMs: config.cache.storageStatMs,
      listTtlMs: config.cache.storageListMs,
    });
  };
  const worlds = await mount('worlds');
  return {
    worlds,
    ...(config.features.contentReads ? { content: await mount('content'), blobs: await mount('blobs') } : {}),
  };
}

/** Existing public factory returns the worlds mount. */
export async function createStorage(config: ServerConfig) {
  return (await createStorageMounts(config)).worlds;
}
