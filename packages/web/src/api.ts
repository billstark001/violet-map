import type { AssetBundle, BiomeMap, BlockInfoMap, DimensionMap } from '@violet-map/core';

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchWorlds = () => json<{ id: string; dimensions: string[] }[]>('/api/worlds');
export const fetchBundle = () => json<AssetBundle>('/api/assets/bundle');
export const fetchBlockInfo = () => json<BlockInfoMap>('/api/data/blocks');
export const fetchBiomes = () => json<BiomeMap>('/api/data/biomes');
export const fetchDimensions = () => json<DimensionMap>('/api/data/dimensions');

export async function fetchChunk(world: string, dim: string, cx: number, cz: number): Promise<unknown | null> {
  const res = await fetch(`/api/worlds/${world}/${dim}/chunk/${cx}/${cz}`);
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) throw new Error(`chunk fetch failed: ${res.status}`);
  return res.json();
}

export const textureUrl = (id: string) => `/api/assets/texture/${id}`;
