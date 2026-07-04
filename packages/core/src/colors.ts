import { BiomeDef, BiomeMap } from './types.js';

export type Rgb = readonly [number, number, number];
export interface ResolvedBiomeColors { grass: Rgb; foliage: Rgb; water: Rgb; sky: Rgb; fog: Rgb }

export function hexToRgb(hex: number): Rgb {
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
}

/** 原版 colormap 采样：256x256 RGBA 像素。 */
function sampleColormap(map: Uint8Array | null, temperature: number, downfall: number): number {
  if (!map) return 0x48b518;
  const t = Math.min(Math.max(temperature, 0), 1);
  const d = Math.min(Math.max(downfall, 0), 1) * t;
  const x = Math.min(255, Math.floor((1 - t) * 255));
  const y = Math.min(255, Math.floor((1 - d) * 255));
  const i = (y * 256 + x) * 4;
  if (map[i + 3] === 0) return 0x48b518;
  return (map[i] << 16) | (map[i + 1] << 8) | map[i + 2];
}

function grassColorOf(def: BiomeDef, map: Uint8Array | null): number {
  const e = def.effects;
  let c = e.grass_color ?? sampleColormap(map, def.temperature, def.downfall);
  if (e.grass_color_modifier === 'swamp') c = 0x6a7039;
  else if (e.grass_color_modifier === 'dark_forest') c = ((c & 0xfefefe) + 0x28340a) >> 1;
  return c;
}

/** 预先解析每个群系的实际颜色，供网格化时逐顶点使用。 */
export function resolveBiomeColors(
  biomes: BiomeMap,
  grassMap: Uint8Array | null,
  foliageMap: Uint8Array | null,
): Record<string, ResolvedBiomeColors> {
  const out: Record<string, ResolvedBiomeColors> = {};
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