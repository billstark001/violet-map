import { AIR_NAMES, type ChunkColumn, type BlockStateRef } from '@violet-map/core/domain';
import type { BlockInfo } from '@violet-map/core/assets';
import type { TopMapApproach } from '@violet-map/core/formats/top-map';
import type { Rgb } from '../colors.js';
const OVERLAY_ALPHA = { water: 0.58, ice: 0.28, glass: 0.42, translucent: 0.45 } as const;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const clampLight = (value: number) => Math.min(15, Math.max(0, Math.round(value)));
export interface TopMapSurfaceOptions {
  approach: TopMapApproach;
  infoOf(name: string): BlockInfo;
  colorOf(state: BlockStateRef, biome: string): Rgb;
}

export interface TopMapSurfaceSample {
  y: number;
  state: BlockStateRef;
  biome: string;
  color: Rgb;
  sky: number;
  block: number;
}

function localName(name: string): string {
  const separator = name.indexOf(':');
  return separator < 0 ? name : name.slice(separator + 1);
}

function overlayAlpha(state: BlockStateRef, info: BlockInfo): number | null {
  const local = localName(state.name);
  if (info.fluid || local.includes('water')) return OVERLAY_ALPHA.water;
  if (local.includes('ice')) return OVERLAY_ALPHA.ice;
  if (local.includes('glass')) return OVERLAY_ALPHA.glass;
  if (info.layer === 'translucent') return OVERLAY_ALPHA.translucent;
  return null;
}

function mixColor(base: Rgb, over: Rgb, alpha: number): Rgb {
  const a = clamp01(alpha);
  return [base[0] * (1 - a) + over[0] * a, base[1] * (1 - a) + over[1] * a, base[2] * (1 - a) + over[2] * a];
}

function applyTransparentLayers(base: Rgb, layers: { color: Rgb; alpha: number }[]): Rgb {
  let color = base;
  for (let i = layers.length - 1; i >= 0; i--) color = mixColor(color, layers[i].color, layers[i].alpha);
  return color;
}

/** Sample the first visible surface from above or below, compositing transparent blocks. */
export function sampleTopMapSurface(
  col: ChunkColumn,
  x: number,
  z: number,
  opts: TopMapSurfaceOptions,
): TopMapSurfaceSample | null {
  const top = opts.approach === 'top';
  const start = top ? col.maxY - 1 : col.minY;
  const end = top ? col.minY - 1 : col.maxY;
  const delta = top ? -1 : 1;
  const layers: { color: Rgb; alpha: number }[] = [];
  let surfaceY = 0;
  let surfaceState: BlockStateRef | null = null;
  let surfaceBiome = 'minecraft:plains';
  let baseColor: Rgb | null = null;

  for (let y = start; y !== end; y += delta) {
    const state = col.getBlock(x, y, z);
    if (AIR_NAMES.has(state.name)) continue;
    const biome = col.getBiome(x, y, z);
    const info = opts.infoOf(state.name);
    if (!surfaceState) {
      surfaceY = y;
      surfaceState = state;
      surfaceBiome = biome;
    }
    const alpha = overlayAlpha(state, info);
    if (alpha !== null) {
      layers.push({ color: opts.colorOf(state, biome), alpha });
      continue;
    }
    baseColor = opts.colorOf(state, biome);
    break;
  }

  if (!surfaceState) return null;
  const color = baseColor
    ? applyTransparentLayers(baseColor, layers)
    : applyTransparentLayers(layers.at(-1)?.color ?? opts.colorOf(surfaceState, surfaceBiome), layers.slice(0, -1));
  const lightY = top ? surfaceY + 1 : surfaceY - 1;
  return {
    y: surfaceY,
    state: surfaceState,
    biome: surfaceBiome,
    color,
    sky: clampLight(col.getSkyLight(x, lightY, z)),
    block: clampLight(col.getBlockLight(x, lightY, z)),
  };
}
