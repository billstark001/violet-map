import type { createAuthorization } from './auth.js';
import type { AssetService } from './assets.js';
import type { GameDataService } from './gameData.js';
import type { TopMapService } from './topMap.js';
import type { WorldStore } from './worldStore.js';

import type { WorldStorage } from '@violet-map/core/storage';
import type { UserService } from './users.js';
export interface AppServices {
  storage: WorldStorage;
  assets: AssetService;
  gameData: GameDataService;
  topMap: TopMapService;
  worldStore: WorldStore;
  authorization: ReturnType<typeof createAuthorization>;
  users?: UserService;
  close(): Promise<void>;
}
