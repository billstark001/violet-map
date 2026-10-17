import { apiFetch, apiUrl } from './runtime';
import type {
  WorldInfo,
  WorldCapabilities,
  TopMapDimensionManifest,
  ChunkPayload,
  ChunkHashPayload,
  ChunkCoverage,
  TextureAtlasManifest,
  DiagnosticUploadResponse,
} from '@violet-map/core/contracts';
import { decode, encode } from '@msgpack/msgpack';
import type { AssetBundle, BlockInfoMap } from '@violet-map/core/assets';
import type { BiomeMap, DimensionMap } from '@violet-map/core/domain';
import type { TopMapTilePayload } from '@violet-map/core/formats/top-map';

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(url, init);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchWorlds = (signal?: AbortSignal) => json<WorldInfo[]>('api/worlds', { signal });

export const fetchBundle = (signal?: AbortSignal) => json<AssetBundle>('api/assets/bundle', { signal });

export const fetchBlockInfo = (signal?: AbortSignal) => json<BlockInfoMap>('api/data/blocks', { signal });

export const fetchBiomes = (signal?: AbortSignal) => json<BiomeMap>('api/data/biomes', { signal });

export const fetchDimensions = (signal?: AbortSignal) => json<DimensionMap>('api/data/dimensions', { signal });

async function fetchChunkBatch<T>(
  endpoint: 'chunk-hashes' | 'chunks',
  world: string,
  dim: string,
  chunks: { cx: number; cz: number }[],
  signal?: AbortSignal,
): Promise<T[]> {
  if (!chunks.length) return [];
  const body = encode({ chunks });
  const res = await apiFetch(`api/worlds/${encodeURIComponent(world)}/${encodeURIComponent(dim)}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/msgpack', accept: 'application/msgpack' },
    body,
    signal,
  });
  if (!res.ok) throw new Error(`${endpoint} fetch failed: ${res.status}`);
  const payload = decode(new Uint8Array(await res.arrayBuffer())) as { chunks?: unknown } | null;
  if (!payload || !Array.isArray(payload.chunks)) throw new Error(`invalid ${endpoint} response`);
  return payload.chunks as T[];
}

export function fetchChunkHashes(
  world: string,
  dim: string,
  chunks: { cx: number; cz: number }[],
  signal?: AbortSignal,
): Promise<ChunkHashPayload[]> {
  return fetchChunkBatch('chunk-hashes', world, dim, chunks, signal);
}

export function fetchChunks(
  world: string,
  dim: string,
  chunks: { cx: number; cz: number }[],
  signal?: AbortSignal,
): Promise<ChunkPayload[]> {
  return fetchChunkBatch('chunks', world, dim, chunks, signal);
}

export const fetchTextureAtlas = (ids: string[], signal?: AbortSignal) =>
  json<TextureAtlasManifest>('api/assets/atlas', {
    signal,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  });

export const textureUrl = (id: string) => apiUrl(`api/assets/texture/${encodeURIComponent(id)}`);

export const fetchWorldCapabilities = (world: string, signal?: AbortSignal) =>
  json<WorldCapabilities>(`api/worlds/${encodeURIComponent(world)}/capabilities`, { signal });

export const fetchTopMapManifest = (world: string, dim: string, signal?: AbortSignal) =>
  json<TopMapDimensionManifest>(`api/worlds/${encodeURIComponent(world)}/${encodeURIComponent(dim)}/top-map/manifest`, {
    signal,
  });

export const fetchChunkSourceCoverage = (world: string, dim: string, signal?: AbortSignal) =>
  json<ChunkCoverage>(`api/worlds/${encodeURIComponent(world)}/${encodeURIComponent(dim)}/chunk-coverage`, { signal });

export async function uploadDiagnosticSnapshot(snapshot: unknown, token?: string): Promise<DiagnosticUploadResponse> {
  const res = await apiFetch('api/diagnostics', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(snapshot),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const message = typeof detail?.error === 'string' ? `: ${detail.error}` : '';
    throw new Error(`diagnostic upload failed: ${res.status}${message}`);
  }
  return res.json() as Promise<DiagnosticUploadResponse>;
}

export async function fetchTopMapTile(
  world: string,
  dim: string,
  rx: number,
  rz: number,
  signal?: AbortSignal,
): Promise<TopMapTilePayload> {
  const res = await apiFetch(
    `api/worlds/${encodeURIComponent(world)}/${encodeURIComponent(dim)}/top-map/tile/${rx}/${rz}`,
    {
      headers: { accept: 'application/msgpack' },
      signal,
    },
  );
  if (!res.ok) throw new Error(`top-map tile fetch failed: ${res.status}`);
  return decode(new Uint8Array(await res.arrayBuffer())) as TopMapTilePayload;
}
