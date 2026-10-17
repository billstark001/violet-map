import { Hono, type Context } from 'hono';

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { decode, encode } from '@msgpack/msgpack';
import { parseByteRange } from '../httpRange.js';
import { ChunkReadLimiter, ChunkServiceBusyError } from '../chunkReadLimiter.js';
import { isChunkCoordinate, parseChunkCoordinates } from '../chunkCoordinates.js';
import { readLimitedBody } from '../limitedBody.js';
import { isDimensionId } from '@violet-map/core/domain';
import { REQUIRED_ROLE } from '../auth.js';
import { cleanStoragePath } from '@violet-map/storage';
import type { ServerConfig } from '../configuration.js';

import type { AppServices } from '../serviceTypes.js';

export function createRouteContext(app: Hono, config: ServerConfig, services: AppServices) {
  const worldStorage = services.mounts.worlds;
  const {
    buildAssetBundle,
    buildTextureAtlas,
    clearTextureAtlasCache,
    getAssetBundlePayload,
    getTextureAtlasPng,
    readTextureFile,
    MAX_ATLAS_TEXTURES,
  } = services.assets;
  const { buildBlockInfo, clearGameDataCaches, readBiomes, readDimensions, writeDataFile } = services.gameData;
  const { getTopMapManifest, getWorldCapabilities, readTopMapTile } = services.topMap;
  const {
    createWorld,
    deleteChunks,
    deleteRegion,
    deleteWorld,
    diffWorldManifest,
    getChunkMetadataBatch,
    getChunksNbtWithMetaBatch,
    getChunkNbtWithMeta,
    invalidateStoredFile,
    listChunkSourceCoverage,
    listRegions,
    listWorlds,
    saveChunkNbt,
    saveRegionFile,
    saveWorldFile,
    worldManifest,
  } = services.worldStore;

  const { requireRole } = services.authorization;
  const MAX_DIAGNOSTIC_BYTES = config.limits.diagnosticBytes;
  const MAX_CHUNK_REQUEST_BYTES = config.limits.chunkRequestBytes;
  const MAX_ATLAS_REQUEST_BYTES = config.limits.atlasRequestBytes;
  const MAX_CONCURRENT_CHUNK_READS = config.limits.chunkReads;
  const MAX_QUEUED_CHUNK_READS = config.limits.chunkQueue;
  const objectPayloadCache = new WeakMap<object, { body: string; etag: string }>();
  const chunkReadLimiter = new ChunkReadLimiter(MAX_CONCURRENT_CHUNK_READS, MAX_QUEUED_CHUNK_READS);
  function msgpackBody(value: unknown): ArrayBuffer {
    const bytes = encode(value);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  function publicChunkMeta<T extends { sourcePath?: string; entitySourcePath?: string }>(
    value: T,
  ): Omit<T, 'sourcePath' | 'entitySourcePath'> {
    const { sourcePath: _sourcePath, entitySourcePath: _entitySourcePath, ...rest } = value;
    return rest;
  }
  function jsonPayload(c: Context, payload: { body: string; etag: string }, cacheControl: string) {
    const headers = {
      etag: payload.etag,
      'cache-control': cacheControl,
      'content-type': 'application/json; charset=utf-8',
    };
    if (c.req.header('if-none-match') === payload.etag) return c.body(null, 304, headers);
    return c.body(payload.body, 200, headers);
  }
  function cachedObjectPayload(value: object): { body: string; etag: string } {
    const cached = objectPayloadCache.get(value);
    if (cached) return cached;
    const body = JSON.stringify(value);
    const payload = { body, etag: `"${createHash('sha1').update(body).digest('hex')}"` };
    objectPayloadCache.set(value, payload);
    return payload;
  }
  function adminStoragePath(c: { req: { path: string } }, segment: 'files' | 'stat'): string {
    const prefix = `/api/admin/storage/${segment}/`;
    return cleanStoragePath(decodeURIComponent(c.req.path.slice(prefix.length)));
  }

  return {
    app,
    config,
    content: services.content,
    mounts: services.mounts,
    worldStorage,
    buildAssetBundle,
    buildTextureAtlas,
    clearTextureAtlasCache,
    getAssetBundlePayload,
    getTextureAtlasPng,
    readTextureFile,
    MAX_ATLAS_TEXTURES,
    buildBlockInfo,
    clearGameDataCaches,
    readBiomes,
    readDimensions,
    writeDataFile,
    getTopMapManifest,
    getWorldCapabilities,
    readTopMapTile,
    createWorld,
    deleteChunks,
    deleteRegion,
    deleteWorld,
    diffWorldManifest,
    getChunkMetadataBatch,
    getChunksNbtWithMetaBatch,
    getChunkNbtWithMeta,
    invalidateStoredFile,
    listChunkSourceCoverage,
    listRegions,
    listWorlds,
    saveChunkNbt,
    saveRegionFile,
    saveWorldFile,
    worldManifest,
    requireRole,
    MAX_DIAGNOSTIC_BYTES,
    MAX_CHUNK_REQUEST_BYTES,
    MAX_ATLAS_REQUEST_BYTES,
    MAX_CONCURRENT_CHUNK_READS,
    MAX_QUEUED_CHUNK_READS,
    objectPayloadCache,
    chunkReadLimiter,
    msgpackBody,
    publicChunkMeta,
    jsonPayload,
    cachedObjectPayload,
    adminStoragePath,
    createHash,
    randomUUID,
    fs,
    path,
    decode,
    encode,
    parseByteRange,
    ChunkReadLimiter,
    ChunkServiceBusyError,
    isChunkCoordinate,
    parseChunkCoordinates,
    readLimitedBody,
    isDimensionId,
    REQUIRED_ROLE,
    cleanStoragePath,
  };
}
export type RouteContext = ReturnType<typeof createRouteContext>;
