import { CachedStorage, ScopedStorage } from '@violet-map/storage';
import { createObjectStorage } from '@violet-map/storage/factory';
import type { ServerConfig } from './configuration.js';

export async function createStorageMounts(config: ServerConfig, onWorldMutation?: () => void) {
  const observations: { role: string; storage: CachedStorage }[] = [];
  const physical = new Map<string, import('@violet-map/core/storage').ObjectStorage>();
  const openMount = async (
    { backend: id, prefix }: import('./configuration.js').StorageMount,
    onMutation?: () => void,
    authoritative = false,
    role = 'source',
  ) => {
    let backend = physical.get(id);
    if (!backend) {
      const definition = config.storage.backends[id];
      backend =
        definition.driver === 'server'
          ? new (await import('@violet-map/storage/server')).ServerWorldStorage({
              url: definition.url,
              token: definition.token,
            })
          : await createObjectStorage(
              definition.driver === 'local' ? { kind: 'local', root: definition.root } : { ...definition, kind: 's3' },
            );
      physical.set(id, backend);
    }
    const mounted = new CachedStorage(new ScopedStorage(backend, prefix), {
      metadataBytes: Math.floor(config.resources.cache.metadataBytes / 32),
      statTtlMs: onMutation || authoritative ? 0 : config.cache.storageStatMs,
      onMutation,
      listTtlMs: onMutation || authoritative ? 0 : config.cache.storageListMs,
    });
    observations.push({ role, storage: mounted });
    return mounted;
  };
  const mount = (name: 'worlds' | 'content' | 'blobs') =>
    openMount(config.storage.mounts[name], name === 'worlds' ? onWorldMutation : undefined, false, name);
  const needsSources =
    config.resources.delivery.mode === 'server' ||
    config.resources.roles.includes('publish') ||
    config.features.worldReads ||
    config.features.worldWrites ||
    config.features.dataWrites;
  const worlds = needsSources || config.features.contentReads ? await mount('worlds') : undefined;
  const resourceMount = async (m: import('./configuration.js').StorageMount | null, role: string) =>
    m ? openMount(m, undefined, true, role) : undefined;
  const http = config.resources.delivery.httpPublisher;
  const httpTarget = http
    ? new (await import('@violet-map/storage/http-cas')).HttpCasStorage(
        config.resources.delivery.publicBaseUrl!,
        http.token ? { url: http.url, token: http.token } : undefined,
      )
    : undefined;
  return {
    metrics: () => observations.map(({ role, storage }) => ({ role, backend: storage.kind, ...storage.metrics })),
    close: async () => {
      for (const backend of physical.values())
        if ('close' in backend && typeof backend.close === 'function') await backend.close();
    },
    worlds,
    resourceTarget: httpTarget ?? (await resourceMount(config.resources.delivery.targetMount, 'public-copy')),
    publicationStore: await resourceMount(config.resources.publication.storeMount, 'publication'),
    sharedCache:
      needsSources && config.resources.cache.sharedBytes > 0
        ? await resourceMount(config.resources.cache.sharedMount, 'derived-cache')
        : undefined,
    ...(config.features.contentReads ? { content: await mount('content'), blobs: await mount('blobs') } : {}),
  };
}
