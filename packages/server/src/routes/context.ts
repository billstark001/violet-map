import { type Context, type Hono } from 'hono';

import { decode, encode } from '@msgpack/msgpack';
import { isChunkCoordinate, isDimensionId } from '@violet-map/core/domain';
import { nonSharedByteView, readLimitedBody } from '@violet-map/core/http';
import { cleanStoragePath } from '@violet-map/storage';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { REQUIRED_ROLE } from '../auth.js';
import { parseChunkCoordinates } from '../chunkCoordinates.js';
import { ChunkReadLimiter, ChunkServiceBusyError } from '../chunkReadLimiter.js';
import type { ServerConfig } from '../configuration.js';
import { parseByteRange } from '../httpRange.js';

import type { AppServices } from '../serviceTypes.js';

export function createRouteContext(app: Hono, config: ServerConfig, services: AppServices) {
  if (!services.assets || !services.gameData || !services.topMap || !services.worldStore || !services.mounts.worlds)
    throw new Error('dynamic source routes are disabled');
  const worldStorage = services.mounts.worlds;
  const { buildAssetBundle, clearTextureAtlasCache, MAX_ATLAS_TEXTURES } = services.assets;
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
  function msgpackBody(value: unknown): Uint8Array<ArrayBuffer> {
    const bytes = encode(value);
    return nonSharedByteView(bytes);
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
    resources: services.resources,
    config,
    content: services.content,
    mounts: services.mounts,
    worldStorage,
    buildAssetBundle,
    clearTextureAtlasCache,
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
