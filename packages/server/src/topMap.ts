import type { ObjectReader } from '@violet-map/core/storage';
import { assetDirectoryDigest } from '@violet-map/resources/asset-digest';
import { topMapEnvironment } from '@violet-map/resources/top-map';
import { createTopMapSource } from '@violet-map/resources/top-map-source';
import { createWorldSource } from '@violet-map/resources/world-chunks';
import { RevisionMemo } from '@violet-map/resources';
import { assetDirectoryRevision } from '@violet-map/resources/asset-digest';
import { canonicalJson } from '@violet-map/core/resources';
import type { ServerConfig } from './configuration.js';
import type { GameDataService } from './gameData.js';

export function createTopMapService(reader: ObjectReader, config: ServerConfig, data: GameDataService) {
  const source = () =>
    createWorldSource(reader, {
      entities: false,
      // This reader lives only inside one admitted region validation. Its small
      // header/layout working set is covered by that operation's work budget.
      cache: { regionBytes: 0, chunkNbtBytes: 0, metadataEntries: 16, worldListMs: 0 },
    });
  const environment = new RevisionMemo(Math.floor(config.resources.cache.metadataBytes / 32));
  return createTopMapSource(
    reader,
    source,
    () =>
      environment.get(
        'environment',
        async () => canonicalJson([await assetDirectoryRevision(config.assets.dirs), await data.revision()]),
        async () =>
          topMapEnvironment(
            await assetDirectoryDigest(config.assets.dirs),
            await data.buildBlockInfo(),
            await data.readBiomes(),
          ),
      ),
    () => data.readDimensions(),
    {
      metadataBytes: Math.floor(config.resources.cache.metadataBytes / 32),
      regionRevision: (world, dim, rx, rz) => source().regionRevision(world, dim, rx, rz),
    },
  );
}

export type TopMapService = ReturnType<typeof createTopMapService>;
