import { canonicalJson } from '@violet-map/core/resources';
import type { PublicationStorage } from '@violet-map/resources';
import {
  BlobRepository,
  ByteBudget,
  createActionIndex,
  InvalidationCoordinator,
  MemoryActionIndex,
  PersistentResourceCache,
  PublicationStore,
  PublicTarget,
  ResourceEngine,
} from '@violet-map/resources';
import { ContentAddressedStorage, publicObjectKey, ScopedStorage, sha256 } from '@violet-map/storage';
import { createAuthorization, type Authentication } from './auth.js';
import { createAuthentication } from './authentication.js';
import type { ServerConfig } from './configuration.js';
import { ContentService } from './content.js';
import type { DatabaseOptions } from './db/connection.js';
import type { createDatabaseService } from './db/index.js';
import type { AppServices } from './serviceTypes.js';
import { createStorageMounts } from './storage.js';

export interface ServiceFactories {
  database?: (options: DatabaseOptions) => ReturnType<typeof createDatabaseService>;
}

export async function createServices(config: ServerConfig, factories: ServiceFactories = {}): Promise<AppServices> {
  const coordinator = new InvalidationCoordinator();
  const mounts = await createStorageMounts(config, () => coordinator.invalidate());
  const storage = mounts.worlds;
  const publisher = config.resources.roles.includes('publish');
  const workBudget = new ByteBudget(config.resources.work.memoryBytes);
  const store = mounts.publicationStore
    ? new PublicationStore(
        mounts.publicationStore,
        publisher ? (mounts.publicationStore as PublicationStorage) : undefined,
        Math.floor(config.resources.cache.metadataBytes / 4),
        workBudget,
        config.resources.publication.retainedMs,
      )
    : undefined;
  const target =
    mounts.resourceTarget && store
      ? new PublicTarget(
          mounts.resourceTarget,
          publisher ? (mounts.resourceTarget as PublicationStorage) : undefined,
          config.resources.delivery.publicBaseUrl!,
          store,
          config.server.cors.origins,
          workBudget,
        )
      : undefined;
  const needsDynamic =
    config.resources.delivery.mode === 'server' ||
    publisher ||
    config.features.worldReads ||
    config.features.worldWrites ||
    config.features.dataWrites;
  const needsRepository = needsDynamic || config.features.contentReads;
  let repository: BlobRepository | undefined;
  const layers: PersistentResourceCache[] = [];
  let activeEngine: ResourceEngine | undefined;
  try {
    if (needsRepository) {
      if (needsDynamic && config.resources.cache.local && config.resources.cache.local.bytes > 0) {
        const { LocalStorage } = await import('@violet-map/storage/local');
        const local = new LocalStorage(config.resources.cache.local.directory);
        await local.prepareDirectory();
        const layer = new PersistentResourceCache(
          local,
          config.resources.cache.local.bytes,
          Math.floor(config.resources.cache.metadataBytes / 8192),
          config.resources.cache.writeBytes,
        );
        layers.push(layer);
        await layer.initialize();
      }
      if (needsDynamic && mounts.sharedCache) {
        const layer = new PersistentResourceCache(
          mounts.sharedCache as PublicationStorage,
          config.resources.cache.sharedBytes,
          Math.floor(config.resources.cache.metadataBytes / 8192),
          config.resources.cache.writeBytes,
          publisher,
        );
        layers.push(layer);
        await layer.initialize();
      }
      if (needsDynamic && config.resources.work.workspace) {
        const { LocalStorage } = await import('@violet-map/storage/local');
        await new LocalStorage(config.resources.work.workspace.directory).prepareDirectory();
      }
      const index = needsDynamic
        ? await createActionIndex(config.resources.cache.index, Math.floor(config.resources.cache.metadataBytes / 4))
        : new MemoryActionIndex(0);
      const published = mounts.resourceTarget ? new ContentAddressedStorage(mounts.resourceTarget) : undefined;
      repository = new BlobRepository({
        memoryBytes: config.resources.cache.memoryBytes,
        workBytes: config.resources.work.memoryBytes,
        workBudget,
        handoffBytes: config.resources.work.handoffBytes,
        handoffMs: config.resources.work.handoffMs,
        maxTasks: config.limits.chunkReads + config.limits.atlasBuilds,
        metadataEntries: Math.floor(config.resources.cache.metadataBytes / 8192),
        index,
        source: coordinator,
        layers,
        ...(published ? { readPublishedDerived: (ref) => published.read(ref, publicObjectKey(ref)) } : {}),
      });
    }
    const content: ContentService | undefined =
      mounts.content && mounts.blobs && storage && repository
        ? new ContentService(mounts.content, mounts.blobs, storage, repository, (operation) =>
            resources.mutateSource(operation, 'content'),
          )
        : undefined;
    // Original-source caches do not retain a second copy of derived working sets.
    const sourceConfig = {
      ...config,
      cache: { ...config.cache, regionBytes: 0, chunkNbtBytes: 0, textureBytes: 0, metadataEntries: 0, worldListMs: 0 },
    };
    const assets = needsDynamic
      ? (await import('@violet-map/resources/asset-pack')).createAssetPack(sourceConfig)
      : undefined;
    const gameData = assets
      ? (await import('./gameData.js')).createGameDataService(
          config,
          mounts.blobs ? new ScopedStorage(mounts.blobs, 'server-data') : undefined,
        )
      : undefined;
    const topMap =
      needsDynamic && storage
        ? (await import('./topMap.js')).createTopMapService(storage, config, gameData!)
        : undefined;
    const worldStore =
      needsDynamic && storage && topMap
        ? (await import('./worldStore.js')).createWorldStore(storage, sourceConfig)
        : undefined;
    const dynamic = assets && gameData && topMap && worldStore ? { assets, gameData, topMap, worldStore } : undefined;
    const resources: ResourceEngine = new ResourceEngine(
      {
        resources: config.resources,
        sourceIdentity: sha256(
          canonicalJson({
            prefix: config.storage.mounts.worlds.prefix,
            locator: (() => {
              const backend = config.storage.backends[config.storage.mounts.worlds.backend];
              switch (backend.driver) {
                case 'local':
                  return { root: backend.root };
                case 'server':
                  return { url: backend.url };
                case 's3':
                  return { endpoint: backend.endpoint ?? null, bucket: backend.bucket, region: backend.region ?? null };
              }
            })(),
          }),
        ),
      },
      mounts,
      coordinator,
      repository,
      store,
      target,
      dynamic,
      content,
    );
    activeEngine = resources;
    await resources.resumePublications();
    const base = { mounts, content, assets, gameData, topMap, worldStore, resources };
    let closing: Promise<void> | undefined;
    const closeResources = () =>
      (closing ??= (async () => {
        await content?.drain();
        await resources.close();
        const errors: unknown[] = [];
        for (const close of [() => repository?.close(), () => store?.close(), () => mounts.close()]) {
          try {
            await close();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) throw new AggregateError(errors, 'resource service shutdown failed');
      })());
    if (!config.features.users) {
      const authentication = createAuthentication(config.auth);
      return {
        ...base,
        authorization: createAuthorization(authentication),
        close: async () => {
          await closeResources();
        },
      };
    }
    const database = (factories.database ?? (await import('./db/index.js')).createDatabaseService)({
      databaseDir: config.database.dir,
      databaseUrl: config.database.url,
    });
    try {
      await database.getDatabase();
      const users = (await import('./users.js')).createUserService(database.getDatabase, config.auth);
      const authentication: Authentication = users;
      return {
        ...base,
        users,
        authorization: createAuthorization(authentication),
        close: async () => {
          await closeResources();
          await database.closeDatabase();
        },
      };
    } catch (error) {
      await database.closeDatabase();
      throw error;
    }
  } catch (error) {
    await activeEngine?.close();
    for (const close of [
      () => (repository ? repository.close() : Promise.allSettled(layers.map((layer) => layer.close()))),
      () => store?.close(),
      () => mounts.close(),
    ]) {
      try {
        await close();
      } catch {
        /* Preserve the initialization error after releasing other components. */
      }
    }
    throw error;
  }
}
