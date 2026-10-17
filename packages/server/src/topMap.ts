import { parseTopMapManifest } from '@violet-map/core/formats/top-map';
import type { ServerConfig } from './configuration.js';
import type { ObjectReader } from '@violet-map/core/storage';
import type { WorldCapabilities } from '@violet-map/core/contracts';
import { cleanStoragePath } from '@violet-map/storage';
import { LruCache } from '@violet-map/core/cache';
import { type TopMapManifest } from '@violet-map/core/formats/top-map';
export function createTopMapService(worldStorage: ObjectReader, config: ServerConfig) {
  const WORLD_RE = /^[A-Za-z0-9_.-]+$/;
  const TOP_MAP_ROOT = '.violet-map/top-map';

  interface ManifestCacheEntry {
    validator: string;
    manifest: TopMapManifest | null;
    checkedAt: number;
  }

  const manifestCache = new LruCache<string, ManifestCacheEntry>({ maxEntries: 128 });
  const MANIFEST_REVALIDATE_MS = config.cache.manifestMs;
  let manifestGeneration = 0;

  /** Drop a manifest after a local or protected-storage mutation. */
  function invalidateTopMapManifest(world: string): void {
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

  async function getTopMapManifest(world: string): Promise<TopMapManifest | null> {
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

  async function getWorldCapabilities(world: string): Promise<WorldCapabilities> {
    return toCapabilities(world, await getTopMapManifest(world));
  }

  async function readTopMapTile(world: string, dim: string, rx: number, rz: number): Promise<Uint8Array | null> {
    const manifest = await getTopMapManifest(world);
    const dimension = manifest?.dimensions[dim];
    if (!dimension) return null;
    if (!dimension.hasTopMap) return null;
    if (!dimension.topMap?.regions.some((region) => region.x === rx && region.z === rz)) return null;
    return worldStorage.read(tilePath(world, dim, rx, rz));
  }

  async function warmTopMapManifests(): Promise<void> {
    for (const world of await worldStorage.listDirectories()) {
      if (!WORLD_RE.test(world)) continue;
      await getTopMapManifest(world);
    }
  }
  return { invalidateTopMapManifest, getTopMapManifest, getWorldCapabilities, readTopMapTile, warmTopMapManifests };
}
export type TopMapService = ReturnType<typeof createTopMapService>;
