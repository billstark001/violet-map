import type { ObjectReader } from '@violet-map/core/storage';
import { assetDirectoryDigest } from '@violet-map/resources/asset-digest';
import { topMapEnvironment } from '@violet-map/resources/top-map';
import { createTopMapSource } from '@violet-map/resources/top-map-source';
import { createWorldSource } from '@violet-map/resources/world-chunks';
import type { ServerConfig } from './configuration.js';
import type { GameDataService } from './gameData.js';

export function createTopMapService(reader: ObjectReader, config: ServerConfig, data: GameDataService) {
  const source = () =>
    createWorldSource(reader, {
      entities: false,
      cache: { regionBytes: 32 * 1024 ** 2, chunkNbtBytes: 0, worldListMs: 0 },
    });
  return createTopMapSource(
    reader,
    source,
    async () =>
      topMapEnvironment(
        await assetDirectoryDigest(config.assets.dirs),
        await data.buildBlockInfo(),
        await data.readBiomes(),
      ),
    () => data.readDimensions(),
  );
}

export type TopMapService = ReturnType<typeof createTopMapService>;
