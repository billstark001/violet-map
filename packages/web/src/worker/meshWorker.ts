/// <reference lib="webworker" />
import {
  BlockInfo, ChunkColumn, ChunkNeighborhood, MeshBuffers, MesherResources, ModelBaker,
  computeColumnLight, hexToRgb, meshLodChunk, meshSection, parseChunkColumn,
  resolveBiomeColors, type Rgb, type TintType,
} from '@violet-map/core';
import { parseNbt } from '@violet-map/core/nbt';
import type { SectionMeshMsg, WorkerRequest, WorkerResponse } from './protocol';

const DEFAULT_INFO: BlockInfo = { occludes: false, emit: 0, filter: 0, layer: 'cutout', tint: 'none' };
const WHITE: Rgb = [1, 1, 1];

let res: MesherResources | null = null;
let avgColors: Record<string, [number, number, number]> = {};
let baker: ModelBaker;
let blockInfo: Record<string, BlockInfo> = {};
let biomeColors: ReturnType<typeof resolveBiomeColors> = {};

const columns = new Map<string, { col: ChunkColumn; hasSkyLight: boolean; litSky: boolean; litBlock: boolean }>();
const topColorCache = new Map<string, Rgb>();

function infoOf(name: string): BlockInfo {
  return blockInfo[name] ?? DEFAULT_INFO;
}
function tintOf(type: TintType, fixed: number | undefined, biome: string): Rgb {
  if (fixed !== undefined) return hexToRgb(fixed);
  const bc = biomeColors[biome] ?? biomeColors['default'] ?? biomeColors['minecraft:plains'];
  if (!bc) return WHITE;
  if (type === 'grass') return bc.grass;
  if (type === 'foliage') return bc.foliage;
  if (type === 'water') return bc.water;
  return WHITE;
}

/** LOD 顶面颜色：取默认状态模型朝上面的贴图平均色 × 群系着色。 */
function topColorOf(name: string, biome: string): Rgb {
  const key = `${name}|${biome}`;
  const hit = topColorCache.get(key);
  if (hit) return hit;
  const bi = infoOf(name);
  let color: Rgb = [0.5, 0.5, 0.5];
  if (bi.fluid) {
    const avg = avgColors[bi.fluid.texture] ?? [1, 1, 1];
    const t = tintOf(bi.fluid.tint, undefined, biome);
    color = [avg[0] * t[0], avg[1] * t[1], avg[2] * t[2]];
  } else {
    const quads = baker.getQuads({ name, properties: {} }, 0);
    const up = quads.find((q) => q.face === 'up') ?? quads[0];
    if (up) {
      const avg = avgColors[up.texture] ?? [1, 0, 1];
      const t = up.tintIndex >= 0 ? tintOf(bi.tint, bi.fixedTint, biome) : WHITE;
      color = [avg[0] * t[0], avg[1] * t[1], avg[2] * t[2]];
    }
  }
  topColorCache.set(key, color);
  return color;
}

function ensureLight(entry: { col: ChunkColumn; hasSkyLight: boolean; litSky: boolean; litBlock: boolean }) {
  const needSky = entry.hasSkyLight && !entry.litSky;
  const needBlock = !entry.litBlock;
  if (!needSky && !needBlock) return;
  computeColumnLight(entry.col, (n) => infoOf(n), entry.hasSkyLight, { writeSky: needSky, writeBlock: needBlock });
  entry.litSky = entry.litSky || needSky || !entry.hasSkyLight || entry.col.hasStoredSkyLight;
  entry.litBlock = entry.litBlock || needBlock || entry.col.hasStoredBlockLight;
}

function neighborhoodOf(key: string): ChunkNeighborhood | null {
  const entry = columns.get(key);
  if (!entry) return null;
  const [world, dim] = key.split('|');
  const { col } = entry;
  const hood = new ChunkNeighborhood(col.x - 1, col.z - 1);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const e = columns.get(`${world}|${dim}|${col.x + dx},${col.z + dz}`);
      if (e) { ensureLight(e); hood.set(e.col); }
    }
  }
  return hood;
}

function transfersOf(buffers: (MeshBuffers | null | undefined)[]): Transferable[] {
  const t: Transferable[] = [];
  for (const b of buffers) {
    if (!b) continue;
    t.push(b.positions.buffer, b.uvs.buffer, b.colors.buffer, b.lights.buffer, b.indices.buffer);
  }
  return t;
}

function parseChunkPayload(chunk: ArrayBuffer): ChunkColumn {
  return parseChunkColumn(parseNbt(new Uint8Array(chunk)));
}

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init': {
      baker = new ModelBaker(msg.bundle);
      blockInfo = msg.blockInfo;
      avgColors = msg.avgColors;
      biomeColors = resolveBiomeColors(msg.biomes, msg.grassColormap, msg.foliageColormap);
      res = { baker, info: infoOf, tint: tintOf, atlas: msg.atlasIndex, textureHasAlpha: msg.textureHasAlpha };
      topColorCache.clear();
      break;
    }
    case 'chunk': {
      try {
        const col = parseChunkPayload(msg.chunk);
        columns.set(msg.key, {
          col,
          hasSkyLight: msg.dimension.hasSkyLight,
          litSky: !msg.dimension.hasSkyLight || col.hasStoredSkyLight,
          litBlock: col.hasStoredBlockLight,
        });
        const surfaceY = col.heightAt(8, 8);
        post({ type: 'chunkReady', key: msg.key, biome: col.getBiome(8, surfaceY, 8), surfaceY });
      } catch (e) {
        post({ type: 'chunkError', key: msg.key, error: (e as Error).message });
      }
      break;
    }
    case 'mesh': {
      if (!res) break;
      const entry = columns.get(msg.key);
      const hood = neighborhoodOf(msg.key);
      if (!entry || !hood) break;
      const { col } = entry;
      const sections: SectionMeshMsg[] = [];
      for (let sy = col.minSectionY; sy <= col.maxSectionY; sy++) {
        const s = col.sections.get(sy);
        if (!s || s.isEmpty) continue;
        const layers = meshSection(res, hood, col.x, sy, col.z);
        if (Object.keys(layers).length) sections.push({ sy, layers });
      }
      post(
        { type: 'meshResult', key: msg.key, version: msg.version, sections },
        transfersOf(sections.flatMap((s) => Object.values(s.layers))),
      );
      break;
    }
    case 'lod': {
      const entry = columns.get(msg.key);
      if (!entry) break;
      const mesh = meshLodChunk(entry.col, msg.step, topColorOf, entry.hasSkyLight);
      post({ type: 'lodResult', key: msg.key, version: msg.version, step: msg.step, mesh }, transfersOf([mesh]));
      break;
    }
    case 'drop':
      columns.delete(msg.key);
      break;
  }
};
