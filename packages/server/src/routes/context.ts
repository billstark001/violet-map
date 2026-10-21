import { type Hono } from 'hono';

import { cleanStoragePath } from '@violet-map/storage';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { REQUIRED_ROLE } from '../auth.js';
import { parseChunkCoordinates } from '../chunkCoordinates.js';
import type { ServerConfig } from '../configuration.js';
import { parseByteRange } from '../httpRange.js';

import type { AppServices } from '../serviceTypes.js';

export function createRouteContext(app: Hono, config: ServerConfig, services: AppServices) {
  if (!services.assets || !services.gameData || !services.topMap || !services.worldStore || !services.mounts.worlds)
    throw new Error('dynamic source routes are disabled');
  const worldStorage = services.mounts.worlds;
  const { buildAssetBundle, clearTextureAtlasCache, MAX_ATLAS_TEXTURES } = services.assets;
  const { clearGameDataCaches, writeDataFile } = services.gameData;
  const {
    createWorld,
    deleteChunks,
    deleteRegion,
    deleteWorld,
    diffWorldManifest,
    invalidateStoredFile,
    saveChunkNbt,
    saveRegionFile,
    saveWorldFile,
    worldManifest,
  } = services.worldStore;

  const { requireRole } = services.authorization;
  const MAX_DIAGNOSTIC_BYTES = config.limits.diagnosticBytes;
  const MAX_ATLAS_REQUEST_BYTES = config.limits.atlasRequestBytes;
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
    clearGameDataCaches,
    writeDataFile,
    createWorld,
    deleteChunks,
    deleteRegion,
    deleteWorld,
    diffWorldManifest,
    invalidateStoredFile,
    saveChunkNbt,
    saveRegionFile,
    saveWorldFile,
    worldManifest,
    requireRole,
    MAX_DIAGNOSTIC_BYTES,
    MAX_ATLAS_REQUEST_BYTES,
    adminStoragePath,
    randomUUID,
    fs,
    path,
    parseByteRange,
    parseChunkCoordinates,
    REQUIRED_ROLE,
  };
}

export type RouteContext = ReturnType<typeof createRouteContext>;
