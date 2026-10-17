import { createAuthentication } from './authentication.js';
import type { ServerConfig } from './configuration.js';
import type { AppServices } from './serviceTypes.js';
import { createStorageMounts } from './storage.js';
import { ContentService } from './content.js';
import { ScopedStorage, createPublicObjectUrl } from '@violet-map/storage';
import { createAssetService } from './assets.js';
import { createGameDataService } from './gameData.js';
import { createTopMapService } from './topMap.js';
import { createWorldStore } from './worldStore.js';
import { createAuthorization, type Authentication } from './auth.js';
import type { DatabaseOptions } from './db/connection.js';
import type { createDatabaseService } from './db/index.js';

export interface ServiceFactories {
  database?: (options: DatabaseOptions) => ReturnType<typeof createDatabaseService>;
}

export async function createServices(config: ServerConfig, factories: ServiceFactories = {}): Promise<AppServices> {
  const mounts = await createStorageMounts(config);
  const storage = mounts.worlds;
  const content =
    mounts.content && mounts.blobs
      ? new ContentService(mounts.content, mounts.blobs, storage, {
          publicMediaUrl: config.content.mediaPublicBaseUrl
            ? createPublicObjectUrl(config.content.mediaPublicBaseUrl)
            : undefined,
        })
      : undefined;
  const assets = createAssetService(config);
  const gameData = createGameDataService(
    config,
    assets,
    mounts.blobs ? new ScopedStorage(mounts.blobs, 'server-data') : undefined,
  );
  const topMap = createTopMapService(storage, config);
  const worldStore = createWorldStore(storage, topMap, config);
  const base = { mounts, content, assets, gameData, topMap, worldStore };
  if (!config.features.users) {
    const authentication = createAuthentication(config.auth);
    return {
      ...base,
      authorization: createAuthorization(authentication),
      close: async () => {
        await content?.drain();
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
        await content?.drain();
        await database.closeDatabase();
      },
    };
  } catch (error) {
    await database.closeDatabase();
    throw error;
  }
}
