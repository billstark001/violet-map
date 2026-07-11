/// <reference lib="webworker" />
import {
  BlockInfo, ChunkColumn, ChunkNeighborhood, MeshBuffers, MesherResources, ModelBaker,
  appendChunkEntities, computeColumnLight, hexToRgb, meshLodChunk, meshSection, parseChunkColumn,
  resolveBiomeColors, type BlockStateRef, type RendererDefinitions, type RendererModelDef, type Rgb, type TintType,
} from '@violet-map/core';
import type { RenderModelInstance } from '@violet-map/core';
import { parseNbt } from '@violet-map/core/nbt';
import type { SectionMeshMsg, WorkerRequest, WorkerResponse } from './protocol';

const DEFAULT_INFO: BlockInfo = { occludes: false, emit: 0, filter: 0, layer: 'cutout', tint: 'none' };
const WHITE: Rgb = [1, 1, 1];
const TOP_COLOR_CACHE_LIMIT = 12000;
const SECTION_VISIBILITY_ALL = (() => {
  let mask = 0;
  for (let from = 0; from < 6; from++) {
    for (let to = 0; to < 6; to++) {
      if (from !== to) mask += 2 ** (from * 6 + to);
    }
  }
  return mask;
})();

let res: MesherResources | null = null;
let avgColors: Record<string, [number, number, number]> = {};
let baker: ModelBaker;
let blockInfo: Record<string, BlockInfo> = {};
let biomeColors: ReturnType<typeof resolveBiomeColors> = {};
let rendererDefinitions: RendererDefinitions | undefined;

const columns = new Map<string, { col: ChunkColumn; hasSkyLight: boolean; litSky: boolean; litBlock: boolean }>();
const topColorCache = new Map<string, Rgb>();

function infoOf(name: string): BlockInfo {
  return blockInfo[name] ?? DEFAULT_INFO;
}
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function redstoneTint(state?: BlockStateRef): Rgb {
  const power = Math.min(15, Math.max(0, Number(state?.properties.power ?? '0') || 0));
  const f = power / 15;
  const r = power === 0 ? 0.3 : f * 0.6 + 0.4;
  const g = f * f * 0.7 - 0.5;
  const b = f * f * 0.6 - 0.7;
  return [clamp01(r), clamp01(g), clamp01(b)];
}

function stemTint(state?: BlockStateRef): Rgb {
  const age = Math.min(7, Math.max(0, Number(state?.properties.age ?? '0') || 0));
  return [age * 32 / 255, (255 - age * 8) / 255, age * 4 / 255];
}

function tintOf(type: TintType, fixed: number | undefined, biome: string, state?: BlockStateRef): Rgb {
  if (fixed !== undefined) return hexToRgb(fixed);
  if (type === 'redstone') return redstoneTint(state);
  if (type === 'stem') return stemTint(state);
  if (type === 'attachedStem') return hexToRgb(0xe0c71c);
  const bc = biomeColors[biome] ?? biomeColors['default'] ?? biomeColors['minecraft:plains'];
  if (!bc) return WHITE;
  if (type === 'grass') return bc.grass;
  if (type === 'foliage') return bc.foliage;
  if (type === 'water') return bc.water;
  return WHITE;
}

function firstAverageTexture(ids: string[]): { id: string; avg: Rgb } | null {
  for (const id of ids) {
    const avg = avgColors[id];
    if (avg) return { id, avg };
  }
  return null;
}

function fallbackTexturesForBlock(name: string): string[] {
  const local = name.includes(':') ? name.split(':')[1] : name;
  const textures: string[] = [];
  if (name === 'minecraft:grass_block') textures.push('minecraft:block/grass_block_top', 'minecraft:block/grass_block_side_overlay', 'minecraft:block/grass_block_side');
  if (name === 'minecraft:podzol') textures.push('minecraft:block/podzol_top', 'minecraft:block/dirt');
  if (name === 'minecraft:mycelium') textures.push('minecraft:block/mycelium_top', 'minecraft:block/dirt');
  if (name === 'minecraft:dirt_path') textures.push('minecraft:block/dirt_path_top', 'minecraft:block/dirt');
  if (name === 'minecraft:farmland') textures.push('minecraft:block/farmland_moist', 'minecraft:block/farmland', 'minecraft:block/dirt');
  if (name === 'minecraft:short_grass' || name === 'minecraft:grass') textures.push('minecraft:block/short_grass', 'minecraft:block/grass');
  if (name === 'minecraft:tall_grass') textures.push('minecraft:block/tall_grass_top', 'minecraft:block/tall_grass_bottom', 'minecraft:block/short_grass');
  if (name === 'minecraft:fern') textures.push('minecraft:block/fern');
  if (local.endsWith('_leaves')) textures.push(`minecraft:block/${local}`);
  if (local.endsWith('_log') || local.endsWith('_stem') || local.endsWith('_hyphae')) textures.push(`minecraft:block/${local}_top`, `minecraft:block/${local}`);
  textures.push(`minecraft:block/${local}_top`, `minecraft:block/${local}`);
  return Array.from(new Set(textures));
}

function fallbackColorOf(state: BlockStateRef, biome: string): Rgb | null {
  const found = firstAverageTexture(fallbackTexturesForBlock(state.name));
  if (!found) return null;
  const bi = infoOf(state.name);
  const tint = bi.tint !== 'none'
    ? tintOf(bi.tint, bi.fixedTint, biome, state)
    : (state.name === 'minecraft:grass_block' || state.name === 'minecraft:short_grass' || state.name === 'minecraft:grass' || state.name === 'minecraft:tall_grass' || state.name === 'minecraft:fern')
      ? tintOf('grass', undefined, biome)
      : state.name.endsWith('_leaves')
        ? tintOf('foliage', undefined, biome)
        : WHITE;
  return [found.avg[0] * tint[0], found.avg[1] * tint[1], found.avg[2] * tint[2]];
}

/** LOD 顶面颜色：取实际方块状态模型朝上面的贴图平均色 × 群系着色。 */
function topColorOf(state: BlockStateRef, biome: string): Rgb {
  const props = Object.keys(state.properties).sort().map((k) => `${k}=${state.properties[k]}`).join(',');
  const key = `${state.name}[${props}]|${biome}`;
  const hit = topColorCache.get(key);
  if (hit) {
    topColorCache.delete(key);
    topColorCache.set(key, hit);
    return hit;
  }
  const bi = infoOf(state.name);
  let color: Rgb | null = null;
  if (bi.fluid) {
    const avg = avgColors[bi.fluid.texture] ?? [1, 1, 1];
    const t = tintOf(bi.fluid.tint, undefined, biome, state);
    color = [avg[0] * t[0], avg[1] * t[1], avg[2] * t[2]];
  } else {
    const quads = baker.getQuads(state, 0);
    const up = quads.find((q) => q.face === 'up') ?? quads[0];
    if (up) {
      const avg = avgColors[up.texture];
      if (avg) {
        const t = up.tintIndex >= 0 ? tintOf(bi.tint, bi.fixedTint, biome, state) : WHITE;
        color = [avg[0] * t[0], avg[1] * t[1], avg[2] * t[2]];
      }
    }
  }
  color ??= fallbackColorOf(state, biome) ?? [0.5, 0.5, 0.5];
  topColorCache.set(key, color);
  if (topColorCache.size > TOP_COLOR_CACHE_LIMIT) {
    const oldest = topColorCache.keys().next().value;
    if (oldest) topColorCache.delete(oldest);
  }
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
    t.push(b.positions.buffer, b.colors.buffer, b.lights.buffer, b.indices.buffer);
    if (b.uvs) t.push(b.uvs.buffer);
    if (b.atlasRects) t.push(b.atlasRects.buffer);
    if (b.animations) t.push(b.animations.buffer);
  }
  return t;
}

function meshBytes(b: MeshBuffers | null | undefined): number {
  if (!b) return 0;
  return b.positions.byteLength + (b.uvs?.byteLength ?? 0) + (b.atlasRects?.byteLength ?? 0)
    + b.colors.byteLength + b.lights.byteLength + (b.animations?.byteLength ?? 0) + b.indices.byteLength;
}

function sectionBytes(sections: SectionMeshMsg[]): number {
  let total = 0;
  for (const section of sections) {
    for (const buffers of Object.values(section.layers)) total += meshBytes(buffers);
  }
  return total;
}

function parseChunkPayload(chunk: ArrayBuffer, entities?: ArrayBuffer): ChunkColumn {
  const col = parseChunkColumn(parseNbt(new Uint8Array(chunk)));
  if (entities) {
    // Entity-region data is optional enrichment; a malformed sidecar must not
    // prevent the terrain chunk itself from rendering.
    try { appendChunkEntities(col, parseNbt(new Uint8Array(entities))); } catch { /* ignore */ }
  }
  return col;
}

function matchesVariant(key: string, values: Record<string, unknown>): boolean {
  if (!key) return true;
  return key.split(',').every((pair) => {
    const [name, expected] = pair.split('=');
    return expected.split('|').includes(String(values[name] ?? ''));
  });
}

function resolveRenderer(definition: RendererModelDef, values: Record<string, unknown>): RendererModelDef {
  for (const [key, patch] of Object.entries(definition.variants ?? {})) {
    if (matchesVariant(key, values)) return { ...definition, ...patch, variants: undefined };
  }
  return definition;
}

function layerOf(value: unknown): 'opaque' | 'cutout' | 'translucent' {
  return value === 'translucent' || value === 'cutout' ? value : 'opaque';
}

function rotationOf(definition: RendererModelDef, values: Record<string, unknown>, yaw?: number): number {
  if (definition.useEntityYaw && Number.isFinite(yaw)) return Math.round((yaw ?? 0) / 90) * 90;
  if (typeof definition.rotationY === 'number') return definition.rotationY;
  if (definition.rotationY && typeof definition.rotationY === 'object') {
    return definition.rotationY.values[String(values[definition.rotationY.property] ?? '')] ?? 0;
  }
  return 0;
}

function textureOf(definition: RendererModelDef, blockName?: string): string | undefined {
  const texture = (blockName ? definition.textureByBlock?.[blockName] : undefined) ?? definition.texture;
  return typeof texture === 'string' && texture ? texture : undefined;
}

/** Resolve all render objects from resource registrations. There are no
 * built-in special block or entity ids in this code path. */
function modelInstances(col: ChunkColumn): RenderModelInstance[] {
  const definitions = rendererDefinitions;
  if (!definitions) return [];
  const out: RenderModelInstance[] = [];
  for (const object of col.blockEntities) {
    const definition = definitions.blockEntities?.[object.id];
    if (!definition?.model) continue;
    const state = col.getBlock(Math.floor(object.x), Math.floor(object.y), Math.floor(object.z));
    const values: Record<string, unknown> = { ...object.data, ...state.properties, block: state.name };
    const resolved = resolveRenderer(definition, values);
    if (!resolved.model) continue;
    out.push({
      model: resolved.model, x: object.x, y: object.y, z: object.z,
      layer: layerOf(resolved.layer), offset: resolved.offset, scale: resolved.scale,
      rotationY: rotationOf(resolved, values), texture: textureOf(resolved, state.name),
    });
  }
  for (const object of col.entities) {
    const definition = definitions.entities?.[object.id];
    if (!definition?.model) continue;
    const resolved = resolveRenderer(definition, object.data);
    if (!resolved.model) continue;
    out.push({
      model: resolved.model, x: object.x, y: object.y, z: object.z,
      layer: layerOf(resolved.layer), offset: resolved.offset, scale: resolved.scale,
      rotationY: rotationOf(resolved, object.data, object.yaw), texture: textureOf(resolved),
    });
  }
  return out;
}

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init': {
      baker = new ModelBaker(msg.bundle);
      blockInfo = msg.blockInfo;
      rendererDefinitions = msg.bundle.renderers;
      avgColors = msg.avgColors;
      biomeColors = resolveBiomeColors(msg.biomes, msg.grassColormap, msg.foliageColormap);
      res = {
        baker,
        info: infoOf,
        tint: tintOf,
        atlas: msg.atlasIndex,
        textureHasAlpha: msg.textureHasAlpha,
        textureAnimationIds: msg.textureAnimationIds,
      };
      topColorCache.clear();
      break;
    }
    case 'chunk': {
      const started = performance.now();
      try {
        const col = parseChunkPayload(msg.chunk, msg.entities);
        columns.set(msg.key, {
          col,
          hasSkyLight: msg.dimension.hasSkyLight,
          litSky: !msg.dimension.hasSkyLight || col.hasStoredSkyLight,
          litBlock: col.hasStoredBlockLight,
        });
        const surfaceY = col.heightAt(8, 8);
        post({
          type: 'chunkReady',
          key: msg.key,
          biome: col.getBiome(8, surfaceY, 8),
          surfaceY,
          profile: {
            chunkBytes: msg.chunk.byteLength,
            parseMs: performance.now() - started,
            storedColumns: columns.size,
          },
        });
      } catch (e) {
        post({ type: 'chunkError', key: msg.key, error: (e as Error).message });
      }
      break;
    }
    case 'mesh': {
      if (!res) break;
      const started = performance.now();
      const entry = columns.get(msg.key);
      const hood = neighborhoodOf(msg.key);
      if (!entry || !hood) {
        post({
          type: 'meshResult',
          key: msg.key,
          version: msg.version,
          sections: [],
          profile: {
            meshBytes: 0,
            meshMs: performance.now() - started,
            storedColumns: columns.size,
            sectionCount: 0,
            missingInput: true,
          },
        });
        break;
      }
      const { col } = entry;
      const instances = modelInstances(col);
      const sections: SectionMeshMsg[] = [];
      for (let sy = col.minSectionY; sy <= col.maxSectionY; sy++) {
        const s = col.sections.get(sy);
        const hasInstances = instances.some((instance) => Math.floor(instance.y / 16) === sy);
        const result = s && (!s.isEmpty || hasInstances) ? meshSection(res, hood, col.x, sy, col.z, true, instances) : null;
        const layers = result?.layers ?? {};
        const visibility = result?.visibility ?? SECTION_VISIBILITY_ALL;
        if (Object.keys(layers).length || visibility > 0) sections.push({ sy, layers, visibility });
      }
      const bytes = sectionBytes(sections);
      post(
        {
          type: 'meshResult',
          key: msg.key,
          version: msg.version,
          sections,
          profile: {
            meshBytes: bytes,
            meshMs: performance.now() - started,
            storedColumns: columns.size,
            sectionCount: sections.length,
          },
        },
        transfersOf(sections.flatMap((s) => Object.values(s.layers))),
      );
      break;
    }
    case 'lod': {
      const started = performance.now();
      const entry = columns.get(msg.key);
      if (!entry) {
        post({
          type: 'lodResult',
          key: msg.key,
          version: msg.version,
          step: msg.step,
          mesh: null,
          profile: {
            meshBytes: 0,
            meshMs: performance.now() - started,
            storedColumns: columns.size,
            missingInput: true,
          },
        });
        break;
      }
      const hood = neighborhoodOf(msg.key);
      const mesh = hood
        ? meshLodChunk(entry.col, msg.step, topColorOf, entry.hasSkyLight, hood, infoOf)
        : null;
      post({
        type: 'lodResult',
        key: msg.key,
        version: msg.version,
        step: msg.step,
        mesh,
        profile: { meshBytes: meshBytes(mesh), meshMs: performance.now() - started, storedColumns: columns.size },
      }, transfersOf([mesh]));
      break;
    }
    case 'drop':
      columns.delete(msg.key);
      break;
  }
};
