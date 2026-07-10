import { decode, encode } from '@msgpack/msgpack';
import type {
  AssetBundle,
  AtlasIndex,
  BiomeMap,
  BlockInfoMap,
  DimensionMap,
  TextureAlphaMap,
  TopMapTilePayload,
  TopMapTileSetManifest,
} from '@violet-map/core';

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchWorlds = () => json<{ id: string; dimensions: string[] }[]>('/api/worlds');
export const fetchBundle = () => json<AssetBundle>('/api/assets/bundle');
export const fetchBlockInfo = () => json<BlockInfoMap>('/api/data/blocks');
export const fetchBiomes = () => json<BiomeMap>('/api/data/biomes');
export const fetchDimensions = () => json<DimensionMap>('/api/data/dimensions');

export interface DimensionCapabilities {
  hasTopMap: boolean;
}

export interface WorldCapabilities {
  world: string;
  hasTopMap: boolean;
  dimensions: Record<string, DimensionCapabilities>;
}

export interface TopMapDimensionManifest extends DimensionCapabilities {
  world: string;
  dimension: string;
  topMap?: TopMapTileSetManifest;
}

export interface ChunkPayload extends ChunkHashPayload { data?: Uint8Array }
export interface ChunkHashPayload {
  cx: number;
  cz: number;
  hash?: string;
  fileHash?: string;
  nbtHash?: string;
  source?: 'region' | 'chunk';
  region?: { x: number; z: number };
  missing?: boolean;
}
export interface ChunkSourceCoveragePayload {
  regions: { x: number; z: number; mask?: string }[];
  chunks: { cx: number; cz: number }[];
}
export interface ServerAtlasManifest {
  cacheKey: string;
  image: string;
  width: number;
  height: number;
  index: AtlasIndex;
  avgColors: Record<string, [number, number, number]>;
  hasAlpha: TextureAlphaMap;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function fetchChunk(world: string, dim: string, cx: number, cz: number): Promise<ArrayBuffer | null> {
  const res = await fetch(`/api/worlds/${world}/${dim}/chunk/${cx}/${cz}`);
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
  const res = await fetch(`/api/worlds/${world}/${dim}/chunk-hashes`, {
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
  const res = await fetch(`/api/worlds/${world}/${dim}/chunks`, {
    method: 'POST',
    headers: { 'content-type': 'application/msgpack', accept: 'application/msgpack' },
    body,
  });
  if (!res.ok) throw new Error(`chunk batch fetch failed: ${res.status}`);
  const payload = decode(new Uint8Array(await res.arrayBuffer())) as { chunks?: ChunkPayload[] };
  return payload.chunks ?? [];
}

export const fetchTextureAtlas = (ids: string[]) =>
  json<ServerAtlasManifest>('/api/assets/atlas', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  });

export const textureUrl = (id: string) => `/api/assets/texture/${id}`;

export const fetchWorldCapabilities = (world: string) =>
  json<WorldCapabilities>(`/api/worlds/${encodeURIComponent(world)}/capabilities`);

export const fetchTopMapManifest = (world: string, dim: string) =>
  json<TopMapDimensionManifest>(
    `/api/worlds/${encodeURIComponent(world)}/${encodeURIComponent(dim)}/top-map/manifest`,
  );

export const fetchChunkSourceCoverage = (world: string, dim: string) =>
  json<ChunkSourceCoveragePayload>(
    `/api/worlds/${encodeURIComponent(world)}/${encodeURIComponent(dim)}/chunk-coverage`,
  );

export interface DiagnosticUploadResponse {
  ok: true;
  id: string;
}

export async function uploadDiagnosticSnapshot(snapshot: unknown, token?: string): Promise<DiagnosticUploadResponse> {
  const res = await fetch('/api/diagnostics', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(snapshot),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null) as { error?: unknown } | null;
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
): Promise<TopMapTilePayload> {
  const res = await fetch(`/api/worlds/${encodeURIComponent(world)}/${encodeURIComponent(dim)}/top-map/tile/${rx}/${rz}`, {
    headers: { accept: 'application/msgpack' },
  });
  if (!res.ok) throw new Error(`top-map tile fetch failed: ${res.status}`);
  return decode(new Uint8Array(await res.arrayBuffer())) as TopMapTilePayload;
}
