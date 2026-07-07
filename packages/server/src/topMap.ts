import { cleanStoragePath, worldStorage } from './storage.js';

const WORLD_RE = /^[A-Za-z0-9_.-]+$/;
const TOP_MAP_ROOT = '.violet-map/top-map';
const TOP_MAP_SCHEMA = 5;

export interface TopMapRegionManifestEntry {
  x: number;
  z: number;
  hash: string;
}

export interface TopMapRegionSourceEntry extends TopMapRegionManifestEntry {
  empty: boolean;
}

export interface TopMapTileSetManifest {
  tileSizeBlocks: number;
  sampleStride: number;
  colorStride: number;
  colorVersion: number;
  format: 'msgpack';
  regions: TopMapRegionManifestEntry[];
  sources: TopMapRegionSourceEntry[];
}

export interface TopMapDimensionManifest {
  hasTopMap: boolean;
  hasHeightmap: boolean;
  heightmap?: TopMapTileSetManifest;
}

export interface TopMapManifest {
  schema: 5;
  generatedAt: string;
  world: string;
  dimensions: Record<string, TopMapDimensionManifest>;
}

export interface WorldCapabilities {
  world: string;
  hasTopMap: boolean;
  hasHeightmap: boolean;
  dimensions: Record<string, {
    hasTopMap: boolean;
    hasHeightmap: boolean;
  }>;
}

interface ManifestCacheEntry {
  validator: string;
  manifest: TopMapManifest | null;
}

const manifestCache = new Map<string, ManifestCacheEntry>();

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
  return cleanStoragePath(`${world}/${TOP_MAP_ROOT}/${encodeURIComponent(dim)}/heightmap/r.${rx}.${rz}.msgpack`);
}

function toCapabilities(world: string, manifest: TopMapManifest | null): WorldCapabilities {
  const dimensions: WorldCapabilities['dimensions'] = {};
  for (const [dim, value] of Object.entries(manifest?.dimensions ?? {})) {
    dimensions[dim] = {
      hasTopMap: value.hasTopMap,
      hasHeightmap: value.hasHeightmap,
    };
  }
  const values = Object.values(dimensions);
  return {
    world,
    hasTopMap: values.some((d) => d.hasTopMap),
    hasHeightmap: values.some((d) => d.hasHeightmap),
    dimensions,
  };
}

export async function getTopMapManifest(world: string): Promise<TopMapManifest | null> {
  const path = manifestPath(world);
  const info = await worldStorage.stat(path);
  const currentValidator = info ? validator(info.size, info.modifiedAt, info.etag) : 'missing';
  const cached = manifestCache.get(world);
  if (cached?.validator === currentValidator) return cached.manifest;
  if (!info) {
    manifestCache.set(world, { validator: currentValidator, manifest: null });
    return null;
  }
  const bytes = await worldStorage.read(path);
  if (!bytes) {
    manifestCache.set(world, { validator: currentValidator, manifest: null });
    return null;
  }
  try {
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as TopMapManifest;
    if (manifest.schema !== TOP_MAP_SCHEMA || !manifest.dimensions || typeof manifest.dimensions !== 'object') {
      throw new Error('invalid top-map manifest');
    }
    manifestCache.set(world, { validator: currentValidator, manifest });
    return manifest;
  } catch {
    manifestCache.set(world, { validator: currentValidator, manifest: null });
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
  if (!dimension.hasHeightmap) return null;
  if (!dimension.heightmap?.regions.some((region) => region.x === rx && region.z === rz)) return null;
  return worldStorage.read(tilePath(world, dim, rx, rz));
}

export async function warmTopMapManifests(): Promise<void> {
  for (const world of await worldStorage.listDirectories()) {
    if (!WORLD_RE.test(world)) continue;
    await getTopMapManifest(world);
  }
}
