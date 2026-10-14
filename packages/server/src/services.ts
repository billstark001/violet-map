import { createAuthentication } from './authentication.js';
import type { ServerConfig } from './configuration.js';
import type { AppServices } from './serviceTypes.js';
import { createStorage } from './storage.js';
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
  const storage = await createStorage(config);
  const assets = createAssetService(config);
  const gameData = createGameDataService(config, assets);
  const topMap = createTopMapService(storage, config);
  const worldStore = createWorldStore(storage, topMap, config);
  const base = { storage, assets, gameData, topMap, worldStore };
  if (!config.features.users) {
    const authentication = createAuthentication(config.auth);
    return { ...base, authorization: createAuthorization(authentication), close: async () => {} };
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
      storage,
      assets,
      gameData,
      topMap,
      worldStore,
      users,
      authorization: createAuthorization(authentication),
      close: database.closeDatabase,
    };
  } catch (error) {
    await database.closeDatabase();
    throw error;
  }
}
