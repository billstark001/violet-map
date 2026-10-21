import { loadCapability } from '../capabilities.js';
import { type ChunkColumn, type BlockStateRef } from '@violet-map/core/domain';
import type { ChunkNeighborhood, MesherResources, Rgb } from '@violet-map/render';

const render = await loadCapability('@violet-map/render');
const { computeColumnLight, meshLodChunk, meshSection } = render;

import { type AssetBundle, type AtlasIndex, type BlockInfo } from '@violet-map/core/assets';
import { type ColumnEntry } from './worldInput.js';
import { type MeshStats, meshStats, sectionStats, addStats } from './report.js';

export const DEFAULT_RECT = { u0: 0, v0: 0, u1: 1, v1: 1 };
export const fakeAtlas = new Proxy(Object.create(null), {
  get: (_target, prop) => (typeof prop === 'symbol' ? undefined : DEFAULT_RECT),
}) as AtlasIndex;

export function makeNeighborhood(entries: Map<string, ColumnEntry>, col: ChunkColumn): ChunkNeighborhood {
  const hood = new render.ChunkNeighborhood(col.x - 1, col.z - 1);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const entry = entries.get(`${col.x + dx},${col.z + dz}`);
      if (entry) hood.set(entry.col);
    }
  }
  return hood;
}

export function ensureLight(entry: ColumnEntry, infoOf: (name: string) => BlockInfo, hasSkyLight: boolean) {
  const needSky = hasSkyLight && !entry.litSky;
  const needBlock = !entry.litBlock;
  if (!needSky && !needBlock) return;
  computeColumnLight(entry.col, infoOf, hasSkyLight, { writeSky: needSky, writeBlock: needBlock });
  entry.litSky = entry.litSky || needSky || !hasSkyLight || entry.col.hasStoredSkyLight;
  entry.litBlock = entry.litBlock || needBlock || entry.col.hasStoredBlockLight;
}

export function buildMesherResources(bundle: AssetBundle, infoOf: (name: string) => BlockInfo): MesherResources {
  const baker = new render.ModelBaker(bundle);
  return {
    baker,
    info: infoOf,
    tint: (type, fixed, biome, state) => render.blockTint(type, fixed, biome, undefined, state),
    atlas: fakeAtlas,
    textureHasAlpha: {},
  };
}

export function profileFullColumn(res: MesherResources, hood: ChunkNeighborhood, col: ChunkColumn): MeshStats {
  const total: MeshStats = { vertices: 0, indices: 0, sections: 0 };
  for (let sy = col.minSectionY; sy <= col.maxSectionY; sy++) {
    const section = col.sections.get(sy);
    if (!section || section.isEmpty) continue;
    addStats(total, sectionStats(meshSection(res, hood, col.x, sy, col.z).layers));
  }
  return total;
}

export function profileLodColumn(
  col: ChunkColumn,
  step: number,
  colorOf: (state: BlockStateRef, biome: string) => Rgb,
  hasSkyLight: boolean,
  hood: ChunkNeighborhood,
  infoOf: (name: string) => BlockInfo,
): MeshStats {
  return meshStats(meshLodChunk(col, step, colorOf, hasSkyLight, hood, infoOf));
}
