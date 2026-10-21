import { hashString32, hashBytes32 } from '@violet-map/core/hash';
import type { AssetBundle, BlockInfoMap } from '@violet-map/core/assets';
import type { BiomeMap, DimensionMap } from '@violet-map/core/domain';
import { canonicalJson } from '@violet-map/core/resources';

interface RenderKeyResources {
  atlasKey: string;
  bundle: AssetBundle;
  blockInfo: BlockInfoMap;
  biomes: BiomeMap;
  dimensions: DimensionMap;
  grassMap: Uint8Array | null;
  foliageMap: Uint8Array | null;
}

const MESH_CACHE_SCHEMA = 'mesh-v18-shared-tints-canonical-json';

/** Include every resource that affects mesh colors, geometry or baked lighting.
 * Object key order is irrelevant; this is a cache identity, not an integrity hash. */
export function buildRenderKey(resources: RenderKeyResources): string {
  const { atlasKey, bundle, blockInfo, biomes, dimensions, grassMap, foliageMap } = resources;
  let h = hashString32(`${MESH_CACHE_SCHEMA}:${atlasKey}`);
  for (const document of [bundle, blockInfo, biomes, dimensions]) h = hashString32(canonicalJson(document), h);
  if (grassMap) h = hashBytes32(grassMap, h);
  if (foliageMap) h = hashBytes32(foliageMap, h);
  return `${MESH_CACHE_SCHEMA}:${atlasKey}:${h.toString(36)}`;
}
