import { cleanStoragePath, worldStorage } from './storage.js';
import { TOP_MAP_SCHEMA, type TopMapManifest } from '@violet-map/core';

const WORLD_RE = /^[A-Za-z0-9_.-]+$/;
const TOP_MAP_ROOT = '.violet-map/top-map';

export interface WorldCapabilities {
  world: string;
  hasTopMap: boolean;
  dimensions: Record<
    string,
    {
      hasTopMap: boolean;
    }
  >;
}

interface ManifestCacheEntry {
  validator: string;
  manifest: TopMapManifest | null;
  checkedAt: number;
}

const manifestCache = new Map<string, ManifestCacheEntry>();
const MANIFEST_REVALIDATE_MS = 5_000;
let manifestGeneration = 0;

/** Drop a manifest after a local or protected-storage mutation. */
export function invalidateTopMapManifest(world: string): void {
  manifestGeneration++;
  manifestCache.delete(world);
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Check the fields that the capabilities and tile endpoints dereference. */
function parseTopMapManifest(value: unknown): TopMapManifest | null {
  if (!isRecord(value) || value.schema !== TOP_MAP_SCHEMA || !isRecord(value.dimensions)) return null;
  for (const dimension of Object.values(value.dimensions)) {
    if (!isRecord(dimension) || typeof dimension.hasTopMap !== 'boolean') return null;
    const topMap = dimension.topMap;
    if (dimension.hasTopMap && !isRecord(topMap)) return null;
    if (topMap !== undefined) {
      if (!isRecord(topMap) || !Array.isArray(topMap.regions)) return null;
      for (const region of topMap.regions) {
        if (!isRecord(region) || !Number.isSafeInteger(region.x) || !Number.isSafeInteger(region.z)) return null;
      }
    }
  }
  return value as unknown as TopMapManifest;
}

export async function getTopMapManifest(world: string): Promise<TopMapManifest | null> {
  const path = manifestPath(world);
  const generation = manifestGeneration;
  const cached = manifestCache.get(world);
  if (cached && Date.now() - cached.checkedAt < MANIFEST_REVALIDATE_MS) return cached.manifest;
  const info = await worldStorage.stat(path);
  const currentValidator = info ? validator(info.size, info.modifiedAt, info.etag) : 'missing';
  if (generation === manifestGeneration && cached?.validator === currentValidator) {
    cached.checkedAt = Date.now();
    return cached.manifest;
  }
  if (!info) {
    if (generation === manifestGeneration)
      manifestCache.set(world, { validator: currentValidator, manifest: null, checkedAt: Date.now() });
    return null;
  }
  const bytes = await worldStorage.read(path);
  if (!bytes) {
    if (generation === manifestGeneration)
      manifestCache.set(world, { validator: currentValidator, manifest: null, checkedAt: Date.now() });
    return null;
  }
  try {
    const manifest = parseTopMapManifest(JSON.parse(new TextDecoder().decode(bytes)));
    if (!manifest) throw new Error('invalid top-map manifest');
    if (generation === manifestGeneration)
      manifestCache.set(world, { validator: currentValidator, manifest, checkedAt: Date.now() });
    return manifest;
  } catch {
    if (generation === manifestGeneration)
      manifestCache.set(world, { validator: currentValidator, manifest: null, checkedAt: Date.now() });
    return null;
  }
}

export async function getWorldCapabilities(world: string): Promise<WorldCapabilities> {
  return toCapabilities(world, await getTopMapManifest(world));
}

export async function readTopMapTile(world: string, dim: string, rx: number, rz: number): Promise<Uint8Array | null> {
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
