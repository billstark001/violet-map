import { cleanStoragePath, worldStorage } from './storage.js';
import {
  TOP_MAP_SCHEMA,
  type TopMapManifest,
} from '@violet-map/core';

const WORLD_RE = /^[A-Za-z0-9_.-]+$/;
const TOP_MAP_ROOT = '.violet-map/top-map';

export interface WorldCapabilities {
  world: string;
  hasTopMap: boolean;
  dimensions: Record<string, {
    hasTopMap: boolean;
  }>;
}

interface ManifestCacheEntry {
  validator: string;
  manifest: TopMapManifest | null;
  checkedAt: number;
}

const manifestCache = new Map<string, ManifestCacheEntry>();
const MANIFEST_REVALIDATE_MS = 5_000;

function assertWorldName(world: string) {
  if (!WORLD_RE.test(world)) throw new Error('invalid world name');
}

function manifestPath(world: string): string {
  assertWorldName(world);
  return `${world}/${TOP_MAP_ROOT}/manifest.json`;
}

function validator(size?: number, modifiedAt?: number, etag?: string): string {
  return `${size ?? 0}:${modifiedAt ?? ''}:${etag ?? ''}`;
}

function tilePath(world: string, dim: string, rx: number, rz: number): string {
  assertWorldName(world);
  if (!Number.isInteger(rx) || !Number.isInteger(rz)) throw new Error('bad region coords');
  return cleanStoragePath(`${world}/${TOP_MAP_ROOT}/${encodeURIComponent(dim)}/topmap/r.${rx}.${rz}.msgpack`);
}

function toCapabilities(world: string, manifest: TopMapManifest | null): WorldCapabilities {
  const dimensions: WorldCapabilities['dimensions'] = {};
  for (const [dim, value] of Object.entries(manifest?.dimensions ?? {})) {
    dimensions[dim] = {
      hasTopMap: value.hasTopMap,
    };
  }
  const values = Object.values(dimensions);
  return {
    world,
    hasTopMap: values.some((d) => d.hasTopMap),
    dimensions,
  };
}

export async function getTopMapManifest(world: string): Promise<TopMapManifest | null> {
  const path = manifestPath(world);
  const cached = manifestCache.get(world);
  if (cached && Date.now() - cached.checkedAt < MANIFEST_REVALIDATE_MS) return cached.manifest;
  const info = await worldStorage.stat(path);
  const currentValidator = info ? validator(info.size, info.modifiedAt, info.etag) : 'missing';
  if (cached?.validator === currentValidator) {
    cached.checkedAt = Date.now();
    return cached.manifest;
  }
  if (!info) {
    manifestCache.set(world, { validator: currentValidator, manifest: null, checkedAt: Date.now() });
    return null;
  }
  const bytes = await worldStorage.read(path);
  if (!bytes) {
    manifestCache.set(world, { validator: currentValidator, manifest: null, checkedAt: Date.now() });
    return null;
  }
  try {
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as TopMapManifest;
    if (manifest.schema !== TOP_MAP_SCHEMA || !manifest.dimensions || typeof manifest.dimensions !== 'object') {
      throw new Error('invalid top-map manifest');
    }
    manifestCache.set(world, { validator: currentValidator, manifest, checkedAt: Date.now() });
    return manifest;
  } catch {
    manifestCache.set(world, { validator: currentValidator, manifest: null, checkedAt: Date.now() });
    return null;
  }
}

export async function getWorldCapabilities(world: string): Promise<WorldCapabilities> {
  return toCapabilities(world, await getTopMapManifest(world));
}

export async function readTopMapTile(
  world: string,
  dim: string,
  rx: number,
  rz: number,
): Promise<Uint8Array | null> {
  const manifest = await getTopMapManifest(world);
  const dimension = manifest?.dimensions[dim];
  if (!dimension) return null;
  if (!dimension.hasTopMap) return null;
  if (!dimension.topMap?.regions.some((region) => region.x === rx && region.z === rz)) return null;
  return worldStorage.read(tilePath(world, dim, rx, rz));
}

export async function warmTopMapManifests(): Promise<void> {
  for (const world of await worldStorage.listDirectories()) {
    if (!WORLD_RE.test(world)) continue;
    await getTopMapManifest(world);
  }
}
