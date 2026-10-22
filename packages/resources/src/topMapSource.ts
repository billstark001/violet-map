import { assertDimensionId, assertWorldName } from '@violet-map/core/domain';
import { parseTopMapManifest } from '@violet-map/core/formats/top-map';
import { ResourceError } from '@violet-map/core/resources';
import type { ObjectReader } from '@violet-map/core/storage';
import { verifyArtifact } from '@violet-map/storage';
import type { WorldSource } from './sources/worldChunks.js';
import { prepareTopMapRegion, topMapAction, topMapParameters } from './topMapDependencies.js';
import { RevisionMemo } from './revisionMemo.js';

export function createTopMapSource(
  reader: ObjectReader,
  source: () => Pick<WorldSource, 'readChunks'>,
  environment: () => Promise<string>,
  dimensions: () => Promise<import('@violet-map/core/domain').DimensionMap>,
  options?: {
    metadataBytes: number;
    regionRevision(world: string, dim: string, rx: number, rz: number): Promise<string | undefined>;
  },
) {
  const terrainDigests = new RevisionMemo(options?.metadataBytes ?? 0);
  async function getTopMapManifest(world: string) {
    assertWorldName(world);
    const bytes = await reader.readRange(`${world}/.violet-map/top-map/manifest.json`, 0, 1024 ** 2 + 1);
    if (!bytes) return null;
    if (bytes.byteLength > 1024 ** 2)
      throw new ResourceError('RESOURCE_BUSY', 'topmap manifest exceeds metadata budget');
    const manifest = parseTopMapManifest(JSON.parse(new TextDecoder().decode(bytes)));
    if (!manifest)
      throw new ResourceError('TOPMAP_REBAKE_REQUIRED', 'invalid topmap manifest; rebake with the current CLI');
    const hasTiles = Object.values(manifest.dimensions).some((d) => d.hasTopMap);
    if (!hasTiles) return manifest;
    for (const dim of Object.values(manifest.dimensions))
      if (dim.hasTopMap && dim.topMap?.dependency?.schemaVersion !== 1)
        throw new ResourceError('TOPMAP_REBAKE_REQUIRED', 'topmap requires complete dependencies');
    const current = await environment();
    const currentDimensions = await dimensions();
    for (const [id, dim] of Object.entries(manifest.dimensions))
      if (dim.hasTopMap) {
        const deps = dim.topMap?.dependency;
        if (
          deps?.schemaVersion !== 1 ||
          deps.environment !== current ||
          typeof deps.hasSkyLight !== 'boolean' ||
          deps.hasSkyLight !== (currentDimensions[id]?.hasSkyLight ?? true) ||
          dim.topMap!.regions.some((r) => !r.artifact)
        )
          throw new ResourceError(
            'TOPMAP_REBAKE_REQUIRED',
            'topmap has no valid complete dependency record; rebake with the current CLI',
          );
      }
    return manifest;
  }
  async function readTopMapTile(world: string, dimension: string, rx: number, rz: number) {
    assertWorldName(world);
    assertDimensionId(dimension);
    if (!Number.isSafeInteger(rx) || !Number.isSafeInteger(rz)) throw new TypeError('invalid topmap region');
    const top = (await getTopMapManifest(world))?.dimensions[dimension]?.topMap;
    const entry = top?.regions.find((r) => r.x === rx && r.z === rz);
    if (!entry || !top) return null;
    const terrain = await terrainDigests.get(
      JSON.stringify([world, dimension, rx, rz]),
      () => options?.regionRevision(world, dimension, rx, rz) ?? Promise.resolve(undefined),
      async () => (await prepareTopMapRegion(source(), world, dimension, rx, rz)).digest,
    );
    if (
      entry.hash !==
      topMapAction(terrain, top.dependency!.environment, topMapParameters(top, top.dependency!.hasSkyLight))
    )
      throw new ResourceError('TOPMAP_REBAKE_REQUIRED', 'effective terrain changed; rebake this topmap region');
    const ref = entry.artifact!;
    if (ref.bytes > 16 * 1024 ** 2) throw new ResourceError('RESOURCE_BUSY', 'topmap exceeds tile read budget');
    const bytes = await reader.readRange(
      `${world}/.violet-map/top-map/${encodeURIComponent(dimension)}/topmap/r.${rx}.${rz}.msgpack`,
      0,
      ref.bytes + 1,
    );
    if (!bytes) throw new ResourceError('TOPMAP_REBAKE_REQUIRED', 'topmap tile is missing');
    verifyArtifact(ref, bytes);
    return bytes;
  }
  return { getTopMapManifest, readTopMapTile };
}
