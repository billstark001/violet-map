import { loadCapability } from '../capabilities.js';
import { AIR_NAMES, normalizeId, type BiomeMap, type BlockStateRef } from '@violet-map/core/domain';
import type { ResolvedBiomeColors, Rgb } from '@violet-map/render';

const { MISSING_TEXTURE, ModelBaker, hexToRgb, resolveBiomeColors } = await loadCapability('@violet-map/render');

import { type BlockInfo, type BlockInfoMap, type TintType } from '@violet-map/core/assets';
import {
  readTextureAverageColors,
  dataFileCandidates,
  readJsonFirst,
  readColormapFromAssets,
  loadAssetBundleFromDirs,
} from './assetInput.js';

export const DEFAULT_BLOCK_INFO: BlockInfo = { occludes: true, emit: 0, filter: 15, layer: 'opaque', tint: 'none' };
export const AIR_BLOCK_INFO: BlockInfo = { occludes: false, emit: 0, filter: 0, layer: 'cutout', tint: 'none' };
export const WHITE: Rgb = [1, 1, 1];

export type BiomeColorMap = Record<string, ResolvedBiomeColors>;

export function localName(name: string): string {
  return name.includes(':') ? name.split(':')[1] : name;
}

export function hashColor(id: string): Rgb {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const r = 0.35 + ((h & 0xff) / 255) * 0.45;
  const g = 0.35 + (((h >>> 8) & 0xff) / 255) * 0.45;
  const b = 0.35 + (((h >>> 16) & 0xff) / 255) * 0.45;
  return [r, g, b];
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function redstoneTint(state?: BlockStateRef): Rgb {
  const power = Math.min(15, Math.max(0, Number(state?.properties.power ?? '0') || 0));
  const f = power / 15;
  return [power === 0 ? 0.3 : f * 0.6 + 0.4, clamp01(f * f * 0.7 - 0.5), clamp01(f * f * 0.6 - 0.7)];
}

export function stemTint(state?: BlockStateRef): Rgb {
  const age = Math.min(7, Math.max(0, Number(state?.properties.age ?? '0') || 0));
  return [(age * 32) / 255, (255 - age * 8) / 255, (age * 4) / 255];
}

export function tintOf(
  type: TintType,
  fixed: number | undefined,
  biome = 'minecraft:plains',
  biomeColors?: BiomeColorMap | null,
  state?: BlockStateRef,
): Rgb {
  if (fixed !== undefined) return hexToRgb(fixed);
  if (type === 'redstone') return redstoneTint(state);
  if (type === 'stem') return stemTint(state);
  if (type === 'attachedStem') return hexToRgb(0xe0c71c);
  const resolved = biomeColors?.[biome] ?? biomeColors?.default ?? biomeColors?.['minecraft:plains'];
  if (resolved) {
    if (type === 'grass') return resolved.grass;
    if (type === 'foliage') return resolved.foliage;
    if (type === 'water') return resolved.water;
  }
  if (type === 'grass') return [0.48, 0.68, 0.29];
  if (type === 'foliage') return [0.36, 0.58, 0.25];
  if (type === 'water') return [0.25, 0.42, 0.95];
  return WHITE;
}

export function infoGetter(blockInfo?: BlockInfoMap): (name: string) => BlockInfo {
  return (name) => {
    if (AIR_NAMES.has(name)) return AIR_BLOCK_INFO;
    return blockInfo?.[name] ?? DEFAULT_BLOCK_INFO;
  };
}

export function stateColor(state: BlockStateRef): Rgb {
  return AIR_NAMES.has(state.name) ? [0, 0, 0] : hashColor(state.name);
}

export function makeColorOf(infoOf: (name: string) => BlockInfo): (state: BlockStateRef, biome: string) => Rgb {
  const cache = new Map<string, Rgb>();
  return (state) => {
    const hit = cache.get(state.name);
    if (hit) return hit;
    const info = infoOf(state.name);
    const tint = info.fluid ? tintOf(info.fluid.tint, undefined) : tintOf(info.tint, info.fixedTint);
    const base = info.fluid ? hashColor(info.fluid.texture) : hashColor(state.name);
    const color: Rgb = [base[0] * tint[0], base[1] * tint[1], base[2] * tint[2]];
    cache.set(state.name, color);
    return color;
  };
}

export function stateKey(state: BlockStateRef): string {
  const keys = Object.keys(state.properties).sort();
  return `${state.name}[${keys.map((k) => `${k}=${state.properties[k]}`).join(',')}]`;
}

export async function loadBiomeColors(assetDirs: string[], biomesFile?: string): Promise<BiomeColorMap | null> {
  const biomes = await readJsonFirst<BiomeMap>(dataFileCandidates('biomes.json', biomesFile));
  if (!biomes) return null;
  const [grass, foliage] = await Promise.all([
    readColormapFromAssets(assetDirs, 'grass'),
    readColormapFromAssets(assetDirs, 'foliage'),
  ]);
  return resolveBiomeColors(biomes, grass, foliage);
}

export function inferredTint(state: BlockStateRef, info: BlockInfo): TintType {
  if (info.tint !== 'none') return info.tint;
  const name = localName(state.name);
  if (name.includes('water') || name.includes('seagrass') || name.includes('kelp')) return 'water';
  if (name.includes('leaves') || name.includes('vine')) return 'foliage';
  if (name.includes('grass') || name.includes('fern')) return 'grass';
  return 'none';
}

export function firstAverageTexture(textureColors: Map<string, Rgb>, ids: string[]): Rgb | null {
  for (const id of ids) {
    const avg = textureColors.get(id);
    if (avg) return avg;
  }
  return null;
}

export function fallbackTexturesForBlock(name: string): string[] {
  const local = localName(name);
  const textures: string[] = [];
  if (name === 'minecraft:grass_block')
    textures.push(
      'minecraft:block/grass_block_top',
      'minecraft:block/grass_block_side_overlay',
      'minecraft:block/grass_block_side',
    );
  if (name === 'minecraft:podzol') textures.push('minecraft:block/podzol_top', 'minecraft:block/dirt');
  if (name === 'minecraft:mycelium') textures.push('minecraft:block/mycelium_top', 'minecraft:block/dirt');
  if (name === 'minecraft:dirt_path') textures.push('minecraft:block/dirt_path_top', 'minecraft:block/dirt');
  if (name === 'minecraft:farmland')
    textures.push('minecraft:block/farmland_moist', 'minecraft:block/farmland', 'minecraft:block/dirt');
  if (name === 'minecraft:short_grass' || name === 'minecraft:grass')
    textures.push('minecraft:block/short_grass', 'minecraft:block/grass');
  if (name === 'minecraft:tall_grass')
    textures.push('minecraft:block/tall_grass_top', 'minecraft:block/tall_grass_bottom', 'minecraft:block/short_grass');
  if (name === 'minecraft:fern') textures.push('minecraft:block/fern');
  if (local.endsWith('_leaves')) textures.push(`minecraft:block/${local}`);
  if (local.endsWith('_log') || local.endsWith('_stem') || local.endsWith('_hyphae'))
    textures.push(`minecraft:block/${local}_top`, `minecraft:block/${local}`);
  textures.push(`minecraft:block/${local}_top`, `minecraft:block/${local}`);
  return Array.from(new Set(textures));
}

export function fallbackSurfaceColor(
  state: BlockStateRef,
  biome: string,
  fallbackColorOf: (state: BlockStateRef, biome: string) => Rgb,
  infoOf: (name: string) => BlockInfo,
  textureColors: Map<string, Rgb>,
  biomeColors?: BiomeColorMap | null,
): Rgb {
  const found = firstAverageTexture(textureColors, fallbackTexturesForBlock(state.name));
  if (found) {
    const info = infoOf(state.name);
    const tint =
      info.tint !== 'none'
        ? tintOf(info.tint, info.fixedTint, biome, biomeColors, state)
        : tintOf(inferredTint(state, info), info.fixedTint, biome, biomeColors, state);
    return [found[0] * tint[0], found[1] * tint[1], found[2] * tint[2]];
  }
  const name = localName(state.name);
  if (name.includes('water')) return tintOf('water', undefined, biome, biomeColors, state);
  if (name.includes('lava')) return [1, 0.34, 0.05];
  return fallbackColorOf(state, biome);
}

export async function makeTextureColorOf(
  assetDirs: string[],
  infoOf: (name: string) => BlockInfo,
  biomeColors?: BiomeColorMap | null,
): Promise<((state: BlockStateRef, biome: string) => Rgb) | null> {
  const bundle = await loadAssetBundleFromDirs(assetDirs);
  if (!Object.keys(bundle.blockstates).length && !Object.keys(bundle.models).length) return null;
  const textureColors = await readTextureAverageColors(assetDirs);
  if (!textureColors.size) return null;
  const baker = new ModelBaker(bundle);
  const cache = new Map<string, Rgb>();
  const fallbackColorOf = makeColorOf(infoOf);
  return (state, biome) => {
    if (AIR_NAMES.has(state.name)) return [0, 0, 0];
    const key = `${stateKey(state)}|${biomeColors ? biome : ''}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const info = infoOf(state.name);
    let color: Rgb | null = null;
    if (info.fluid) {
      const avg = textureColors.get(info.fluid.texture) ?? [1, 1, 1];
      const tint = tintOf(info.fluid.tint, undefined, biome, biomeColors, state);
      color = [avg[0] * tint[0], avg[1] * tint[1], avg[2] * tint[2]];
    } else {
      const quads = baker.getQuads(state, 0);
      const up = quads.find((q) => q.face === 'up') ?? quads[0];
      if (up && up.texture !== MISSING_TEXTURE) {
        const avg = textureColors.get(normalizeId(up.texture)) ?? textureColors.get(up.texture);
        if (avg) {
          const tint = up.tintIndex >= 0 ? tintOf(info.tint, info.fixedTint, biome, biomeColors, state) : WHITE;
          color = [avg[0] * tint[0], avg[1] * tint[1], avg[2] * tint[2]];
        }
      }
    }
    color ??= fallbackSurfaceColor(state, biome, fallbackColorOf, infoOf, textureColors, biomeColors);
    cache.set(key, color);
    return color;
  };
}
