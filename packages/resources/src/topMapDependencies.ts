import { parseChunkColumn } from '@violet-map/core/domain';
import { parseNbt } from '@violet-map/core/nbt';
import { canonicalJson, ResourceError } from '@violet-map/core/resources';
import { sha256 } from '@violet-map/storage';
import type { WorldSource } from './sources/worldChunks.js';

export const TOPMAP_GENERATOR = 'topmap-v6-colors4-light1-dependencies1';

export interface TopMapDependencies {
  schemaVersion: 1;
  environment: string;
  hasSkyLight: boolean;
}

/** Uses the effective override-before-region terrain source, exactly as the viewer does. */
export async function prepareTopMapRegion(
  source: Pick<WorldSource, 'readChunks'>,
  world: string,
  dimension: string,
  rx: number,
  rz: number,
  columns = false,
) {
  const dependencies: { cx: number; cz: number; digest: string | null }[] = [];
  const entries = new Map<string, { col: ReturnType<typeof parseChunkColumn>; litSky: boolean; litBlock: boolean }>();
  let inputBytes = 0;
  for (let z = 0; z < 32; z++)
    for (let x = 0; x < 32; x++) {
      const cx = rx * 32 + x,
        cz = rz * 32 + z;
      const chunk = (await source.readChunks(world, dimension, [{ cx: cx, cz: cz }]))[0] ?? null;
      dependencies.push({ cx, cz, digest: chunk?.terrainDigest ?? null });
      if (chunk && columns) {
        inputBytes += chunk.data.byteLength;
        if (inputBytes > 64 * 1024 ** 2)
          throw new ResourceError('RESOURCE_BUSY', 'topmap region exceeds terrain input budget');
        const col = parseChunkColumn(parseNbt(chunk.data));
        entries.set(`${cx},${cz}`, { col, litSky: col.hasStoredSkyLight, litBlock: col.hasStoredBlockLight });
      }
    }
  return { digest: sha256(canonicalJson(dependencies)), entries };
}

export function topMapAction(terrain: string, environment: string, parameters: unknown) {
  return sha256(canonicalJson({ generator: TOPMAP_GENERATOR, terrain, environment, parameters }));
}

export function topMapParameters(
  top: { sampleStride: number; colorStride: number; lightStride: number; approach: string; lightMode: string },
  hasSkyLight: boolean,
) {
  return {
    sampleStride: top.sampleStride,
    colorStride: top.colorStride,
    lightStride: top.lightStride,
    approach: top.approach,
    lightMode: top.lightMode,
    hasSkyLight,
  };
}

export function topMapEnvironment(assets: string, blocks: unknown, biomes: unknown) {
  return sha256(
    canonicalJson({ assets, blocks: JSON.parse(JSON.stringify(blocks)), biomes: JSON.parse(JSON.stringify(biomes)) }),
  );
}
