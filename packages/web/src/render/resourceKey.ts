import type { AssetBundle, BlockInfoMap } from '@violet-map/core/assets';
import type { BiomeMap, DimensionMap } from '@violet-map/core/domain';

interface RenderKeyResources {
  atlasKey: string;
  bundle: AssetBundle;
  blockInfo: BlockInfoMap;
  biomes: BiomeMap;
  dimensions: DimensionMap;
  grassMap: Uint8Array | null;
  foliageMap: Uint8Array | null;
}

const MESH_CACHE_SCHEMA = 'mesh-v16-biome-dimension-resources';

function hashString(input: string, seed = 2166136261): number {
  let h = seed;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hashBytes(bytes: Uint8Array | null, seed = 2166136261): number {
  let h = seed;
  if (!bytes) return h >>> 0;
  for (const byte of bytes) {
    h ^= byte;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** Include every resource that affects mesh colors, geometry or baked lighting.
 * Object key order is irrelevant; this is a cache identity, not an integrity hash. */
export function buildRenderKey(resources: RenderKeyResources): string {
  const { atlasKey, bundle, blockInfo, biomes, dimensions, grassMap, foliageMap } = resources;
  let h = hashString(`${MESH_CACHE_SCHEMA}:${atlasKey}`);
  for (const document of [bundle, blockInfo, biomes, dimensions]) h = hashString(stableStringify(document), h);
  h = hashBytes(grassMap, h);
  h = hashBytes(foliageMap, h);
  return `${MESH_CACHE_SCHEMA}:${atlasKey}:${h.toString(36)}`;
}
