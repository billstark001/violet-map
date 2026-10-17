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

export const fetchBundle = () => json<AssetBundle>('api/assets/bundle');

export const fetchBlockInfo = () => json<BlockInfoMap>('api/data/blocks');

export const fetchBiomes = () => json<BiomeMap>('api/data/biomes');

export const fetchDimensions = () => json<DimensionMap>('api/data/dimensions');

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function fetchChunk(world: string, dim: string, cx: number, cz: number): Promise<ArrayBuffer | null> {
  const res = await apiFetch(`api/worlds/${encodeURIComponent(world)}/${encodeURIComponent(dim)}/chunk/${cx}/${cz}`);
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) throw new Error(`chunk fetch failed: ${res.status}`);
  const payload = decode(new Uint8Array(await res.arrayBuffer())) as ChunkPayload;
  return payload.data ? bytesToArrayBuffer(payload.data) : null;
}

export async function fetchChunkHashes(
  world: string,
  dim: string,
  chunks: { cx: number; cz: number }[],
): Promise<ChunkHashPayload[]> {
  if (!chunks.length) return [];
  const body = encode({ chunks });
  const res = await apiFetch(`api/worlds/${encodeURIComponent(world)}/${encodeURIComponent(dim)}/chunk-hashes`, {
    method: 'POST',
    headers: { 'content-type': 'application/msgpack', accept: 'application/msgpack' },
    body,
  });
  if (!res.ok) throw new Error(`chunk hash fetch failed: ${res.status}`);
  const payload = decode(new Uint8Array(await res.arrayBuffer())) as { chunks?: ChunkHashPayload[] };
  return payload.chunks ?? [];
}

export async function fetchChunks(
  world: string,
  dim: string,
  chunks: { cx: number; cz: number }[],
): Promise<ChunkPayload[]> {
  if (!chunks.length) return [];
  const body = encode({ chunks });
  const res = await apiFetch(`api/worlds/${encodeURIComponent(world)}/${encodeURIComponent(dim)}/chunks`, {
    method: 'POST',
    headers: { 'content-type': 'application/msgpack', accept: 'application/msgpack' },
    body,
  });
  if (!res.ok) throw new Error(`chunk batch fetch failed: ${res.status}`);
  const payload = decode(new Uint8Array(await res.arrayBuffer())) as { chunks?: ChunkPayload[] };
  return payload.chunks ?? [];
}

export const fetchTextureAtlas = (ids: string[]) =>
  json<TextureAtlasManifest>('api/assets/atlas', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  });

export const textureUrl = (id: string) => apiUrl(`api/assets/texture/${encodeURIComponent(id)}`);

export const fetchWorldCapabilities = (world: string) =>
  json<WorldCapabilities>(`api/worlds/${encodeURIComponent(world)}/capabilities`);

export const fetchTopMapManifest = (world: string, dim: string, signal?: AbortSignal) =>
  json<TopMapDimensionManifest>(`api/worlds/${encodeURIComponent(world)}/${encodeURIComponent(dim)}/top-map/manifest`, {
    signal,
  });

export const fetchChunkSourceCoverage = (world: string, dim: string) =>
  json<ChunkCoverage>(`api/worlds/${encodeURIComponent(world)}/${encodeURIComponent(dim)}/chunk-coverage`);

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
