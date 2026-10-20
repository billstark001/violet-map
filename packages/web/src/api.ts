import { decode } from '@msgpack/msgpack';
import type { AssetBundle, BlockInfoMap } from '@violet-map/core/assets';
import { mapWithConcurrency } from '@violet-map/core/async';
import type {
  AtlasDocument,
  ChunkCoverage,
  ChunkHashPayload,
  ChunkPayload,
  DiagnosticUploadResponse,
  TextureAtlasManifest,
  TopMapDimensionManifest,
  WorldCapabilities,
  WorldInfo,
} from '@violet-map/core/contracts';
import type { BiomeMap, DimensionMap } from '@violet-map/core/domain';
import type { TopMapTilePayload } from '@violet-map/core/formats/top-map';
import { ResourceError, canonicalJson, type ResourceRef, type ResourceSelector } from '@violet-map/core/resources';
import { resourceClient } from './resources/client';
import { downloadResource } from './resources/download';
import { apiFetch } from './runtime';

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(url, init);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchWorlds = (signal?: AbortSignal) => json<WorldInfo[]>('api/worlds', { signal });

async function selected(selector: ResourceSelector, signal?: AbortSignal, world = '') {
  return (await resourceClient.resolve([selector], world, signal)).resources[0];
}

async function resourceJson<T>(selector: ResourceSelector, signal?: AbortSignal): Promise<T> {
  const result = await selected(selector, signal);
  if (!('resource' in result)) throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'JSON resource is missing');
  if (!['asset-bundle-json-v1', 'game-data-json-v1'].includes(result.resource.artifact.format))
    throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'unknown JSON resource format');
  return JSON.parse(new TextDecoder().decode(await downloadResource(result.resource, signal))) as T;
}

export const fetchBundle = (signal?: AbortSignal) => resourceJson<AssetBundle>({ kind: 'asset-bundle' }, signal);

export const fetchBlockInfo = (signal?: AbortSignal) =>
  resourceJson<BlockInfoMap>({ kind: 'game-data', name: 'blocks' }, signal);

export const fetchBiomes = (signal?: AbortSignal) =>
  resourceJson<BiomeMap>({ kind: 'game-data', name: 'biomes' }, signal);

export const fetchDimensions = (signal?: AbortSignal) =>
  resourceJson<DimensionMap>({ kind: 'game-data', name: 'dimensions' }, signal);

async function resolveChunks(world: string, dim: string, chunks: { cx: number; cz: number }[], signal?: AbortSignal) {
  const head = await resourceClient.head(world, false, signal);
  const out: import('@violet-map/core/resources').ResolvedResource[] = [];
  for (let i = 0; i < chunks.length; i += 128)
    out.push(
      ...(
        await resourceClient.resolve(
          chunks.slice(i, i + 128).map(({ cx, cz }) => ({ kind: 'chunk' as const, world, dimension: dim, cx, cz })),
          world,
          signal,
        )
      ).resources,
    );
  resourceClient.assertCurrent(head, world);
  return { head, results: out };
}

export async function fetchChunkHashes(
  world: string,
  dim: string,
  chunks: { cx: number; cz: number }[],
  signal?: AbortSignal,
): Promise<ChunkHashPayload[]> {
  const { head, results } = await resolveChunks(world, dim, chunks, signal);
  resourceClient.assertCurrent(head, world);
  return results.map((result, index) =>
    'missing' in result
      ? { ...chunks[index], missing: true }
      : 'resource' in result
        ? { ...chunks[index], hash: result.nbtHash, nbtHash: result.nbtHash, entityHash: result.entityHash }
        : (() => {
            throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'chunk selector resolved to an atlas');
          })(),
  );
}

export async function fetchChunks(
  world: string,
  dim: string,
  chunks: { cx: number; cz: number }[],
  signal?: AbortSignal,
): Promise<ChunkPayload[]> {
  const { head, results } = await resolveChunks(world, dim, chunks, signal);
  const payloads = await mapWithConcurrency(results, 4, async (result, index) => {
    if ('missing' in result) return { ...chunks[index], missing: true };
    if (!('resource' in result) || result.resource.artifact.format !== 'chunk-msgpack-v1' || !result.nbtHash)
      throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'invalid chunk resource format');
    const payload = decode(await downloadResource(result.resource, signal)) as {
      schemaVersion?: number;
      cx: number;
      cz: number;
      data: Uint8Array;
      entities?: Uint8Array;
    };
    if (
      payload.schemaVersion !== 1 ||
      payload.cx !== chunks[index].cx ||
      payload.cz !== chunks[index].cz ||
      !(payload.data instanceof Uint8Array) ||
      (payload.entities !== undefined && !(payload.entities instanceof Uint8Array))
    )
      throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'invalid chunk resource payload');
    return {
      cx: payload.cx,
      cz: payload.cz,
      data: payload.data,
      ...(payload.entities ? { entities: payload.entities } : {}),
      hash: result.nbtHash,
      nbtHash: result.nbtHash,
      entityHash: result.entityHash,
    };
  });
  resourceClient.assertCurrent(head, world);
  return payloads;
}

export async function fetchTextureAtlas(ids: string[], signal?: AbortSignal): Promise<TextureAtlasManifest> {
  const result = await selected({ kind: 'atlas', textureSetId: 'default' }, signal);
  if (
    !('manifest' in result) ||
    result.manifest.artifact.format !== 'atlas-manifest-v1' ||
    result.image.artifact.format !== 'png'
  )
    throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'invalid atlas resource');
  const document = JSON.parse(
    new TextDecoder().decode(await downloadResource(result.manifest, signal)),
  ) as AtlasDocument;
  if (
    document.schemaVersion !== 1 ||
    canonicalJson(document.image) !== canonicalJson(result.image.artifact) ||
    !Number.isSafeInteger(document.width) ||
    !Number.isSafeInteger(document.height) ||
    document.width < 1 ||
    document.height < 1 ||
    document.width > 8192 ||
    document.height > 8192 ||
    ids.some((id) => !document.index[id])
  )
    throw new ResourceError('RESOURCE_INTEGRITY_FAILED', 'atlas manifest/image or texture-set mismatch');
  return {
    cacheKey: result.manifest.artifact.digest,
    image: result.image,
    width: document.width,
    height: document.height,
    index: document.index,
    avgColors: document.avgColors,
    hasAlpha: document.hasAlpha,
  };
}

export async function fetchTexture(id: string, signal?: AbortSignal): Promise<ResourceRef | null> {
  const result = await selected({ kind: 'texture', id }, signal);
  if ('missing' in result) return null;
  if (!('resource' in result) || result.resource.artifact.format !== 'png')
    throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'invalid texture resource');
  return result.resource;
}

async function viewJson<T>(world: string, url: string, signal?: AbortSignal): Promise<T> {
  const head = await resourceClient.head(world, false, signal);
  const result = await json<T>(`${url}?viewId=${encodeURIComponent(head.viewId)}`, { signal });
  resourceClient.assertCurrent(head, world);
  return result;
}

export const fetchWorldCapabilities = (world: string, signal?: AbortSignal) =>
  viewJson<WorldCapabilities>(world, `api/worlds/${encodeURIComponent(world)}/capabilities`, signal);

export const fetchTopMapManifest = (world: string, dim: string, signal?: AbortSignal) =>
  viewJson<TopMapDimensionManifest>(
    world,
    `api/worlds/${encodeURIComponent(world)}/${encodeURIComponent(dim)}/top-map/manifest`,
    signal,
  );

export const fetchChunkSourceCoverage = (world: string, dim: string, signal?: AbortSignal) =>
  viewJson<ChunkCoverage>(
    world,
    `api/worlds/${encodeURIComponent(world)}/${encodeURIComponent(dim)}/chunk-coverage`,
    signal,
  );

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
  const { head, resources } = await resourceClient.resolve(
    [{ kind: 'top-map-tile', world, dimension: dim, rx, rz }],
    world,
    signal,
  );
  const result = resources[0];
  if (!('resource' in result) || result.resource.artifact.format !== 'topmap-msgpack-v6')
    throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'invalid top map resource');
  const payload = decode(await downloadResource(result.resource, signal)) as TopMapTilePayload;
  resourceClient.assertCurrent(head, world);
  return payload;
}
