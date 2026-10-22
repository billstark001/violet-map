import { collectTextureIds, type AssetBundle, type BlockInfoMap } from '@violet-map/core/assets';
import type { BiomeMap, DimensionMap } from '@violet-map/core/domain';
import { fetchBiomes, fetchBlockInfo, fetchBundle, fetchDimensions } from '../api';
import { buildAtlas, loadColormap, type BuiltAtlas } from '../atlas';
import { resourceClient } from '../resources/client';
import { loadResource } from '../resources/load';
import { buildRenderKey } from '../resources/renderKey';
import { loadSkyTextures, type SkyTextureImages } from './skyTextures';

export interface ViewerResources {
  bundle: AssetBundle;
  blockInfo: BlockInfoMap;
  biomes: BiomeMap;
  dimensions: DimensionMap;
  grassMap: Uint8Array | null;
  foliageMap: Uint8Array | null;
  atlas: BuiltAtlas;
  sky: SkyTextureImages;
  renderKey: string;
}

/** Prepare one complete render root before any display or terrain work starts. */
export async function loadViewerResources(signal: AbortSignal): Promise<ViewerResources> {
  const head = await loadResource((lifetime) => resourceClient.head('', false, lifetime), signal);
  const [bundle, blockInfo, biomes, dimensions, grassMap, foliageMap] = await Promise.all([
    loadResource(fetchBundle, signal),
    loadResource(fetchBlockInfo, signal),
    loadResource(fetchBiomes, signal),
    loadResource(fetchDimensions, signal),
    loadResource((lifetime) => loadColormap('minecraft:colormap/grass', lifetime), signal),
    loadResource((lifetime) => loadColormap('minecraft:colormap/foliage', lifetime), signal),
  ]);
  const atlas = await loadResource((lifetime) => buildAtlas(collectTextureIds(bundle, blockInfo), lifetime), signal);
  const sky = await loadSkyTextures(signal);
  resourceClient.assertCurrent(head);
  return {
    bundle,
    blockInfo,
    biomes,
    dimensions,
    grassMap,
    foliageMap,
    atlas,
    sky,
    renderKey: buildRenderKey({
      atlasKey: atlas.cacheKey,
      bundle,
      blockInfo,
      biomes,
      dimensions,
      grassMap,
      foliageMap,
    }),
  };
}
