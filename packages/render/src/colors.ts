import type { TintType } from '@violet-map/core/assets';
import { type BiomeDef, type BiomeMap, type BlockStateRef } from '@violet-map/core/domain';

export type Rgb = readonly [number, number, number];

const WHITE: Rgb = [1, 1, 1];
const FALLBACK_GRASS: Rgb = [0.48, 0.68, 0.29];
const FALLBACK_FOLIAGE: Rgb = [0.36, 0.58, 0.25];
const FALLBACK_WATER: Rgb = [0.25, 0.42, 0.95];
const COLORMAP_SIZE = 256;
const COLORMAP_FALLBACK_COLOR = 0x48b518;

export interface ResolvedBiomeColors {
  grass: Rgb;
  foliage: Rgb;
  water: Rgb;
  sky: Rgb;
  fog: Rgb;
}

/** Expand packed 0xRRGGBB to normalized channels without color-space conversion. */
export function hexToRgb(hex: number): Rgb {
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
}

/** 原版 colormap 采样：256x256 RGBA 像素。 */
function sampleColormap(map: Uint8Array | null, temperature: number, downfall: number): number {
  if (
    !map ||
    map.length < COLORMAP_SIZE * COLORMAP_SIZE * 4 ||
    !Number.isFinite(temperature) ||
    !Number.isFinite(downfall)
  )
    return COLORMAP_FALLBACK_COLOR;
  const t = Math.min(Math.max(temperature, 0), 1);
  const d = Math.min(Math.max(downfall, 0), 1) * t;
  const x = Math.min(COLORMAP_SIZE - 1, Math.floor((1 - t) * (COLORMAP_SIZE - 1)));
  const y = Math.min(COLORMAP_SIZE - 1, Math.floor((1 - d) * (COLORMAP_SIZE - 1)));
  const i = (y * COLORMAP_SIZE + x) * 4;
  if (map[i + 3] === 0) return COLORMAP_FALLBACK_COLOR;
  return (map[i] << 16) | (map[i + 1] << 8) | map[i + 2];
}

function grassColorOf(def: BiomeDef, map: Uint8Array | null): number {
  const e = def.effects;
  let c = e.grass_color ?? sampleColormap(map, def.temperature, def.downfall);
  if (e.grass_color_modifier === 'swamp') c = 0x6a7039;
  else if (e.grass_color_modifier === 'dark_forest') c = ((c & 0xfefefe) + 0x28340a) >> 1;
  return c;
}

/** Precompute biome tint channels for repeated vertex lookup. Colormaps are
 * 256² RGBA bytes; missing/truncated maps use the standard foliage fallback.
 * The returned dictionary supports arbitrary keys without inherited entries. */
export function resolveBiomeColors(
  biomes: BiomeMap,
  grassMap: Uint8Array | null,
  foliageMap: Uint8Array | null,
): Record<string, ResolvedBiomeColors> {
  const out: Record<string, ResolvedBiomeColors> = Object.create(null);
  for (const [name, def] of Object.entries(biomes)) {
    out[name] = {
      grass: hexToRgb(grassColorOf(def, grassMap)),
      foliage: hexToRgb(def.effects.foliage_color ?? sampleColormap(foliageMap, def.temperature, def.downfall)),
      water: hexToRgb(def.effects.water_color),
      sky: hexToRgb(def.effects.sky_color),
      fog: hexToRgb(def.effects.fog_color),
    };
  }
  return out;
}

/** State-dependent vanilla tints shared by baked maps and browser meshing. */
function redstoneTint(state?: BlockStateRef): Rgb {
  const power = Math.min(15, Math.max(0, Number(state?.properties.power ?? '0') || 0));
  const f = power / 15;
  return [power === 0 ? 0.3 : f * 0.6 + 0.4, Math.max(0, f * f * 0.7 - 0.5), Math.max(0, f * f * 0.6 - 0.7)];
}

function stemTint(state?: BlockStateRef): Rgb {
  const age = Math.min(7, Math.max(0, Number(state?.properties.age ?? '0') || 0));
  return [(age * 32) / 255, (255 - age * 8) / 255, (age * 4) / 255];
}

/** One tint policy for offline baking and browser meshes, including missing biome data. */
export function blockTint(
  type: TintType,
  fixed: number | undefined,
  biome = 'minecraft:plains',
  biomeColors?: Record<string, ResolvedBiomeColors> | null,
  state?: BlockStateRef,
): Rgb {
  if (fixed !== undefined) return hexToRgb(fixed);
  if (type === 'redstone') return redstoneTint(state);
  if (type === 'stem') return stemTint(state);
  if (type === 'attachedStem') return hexToRgb(0xe0c71c);
  const resolved = biomeColors?.[biome] ?? biomeColors?.default ?? biomeColors?.['minecraft:plains'];
  if (type === 'grass') return resolved?.grass ?? FALLBACK_GRASS;
  if (type === 'foliage') return resolved?.foliage ?? FALLBACK_FOLIAGE;
  if (type === 'water') return resolved?.water ?? FALLBACK_WATER;
  return WHITE;
}
