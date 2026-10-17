import type { BiomeMap } from './domain.js';

const COLOR_FIELDS = ['sky_color', 'fog_color', 'water_color', 'grass_color', 'foliage_color'] as const;
const REQUIRED_COLORS = new Set(['sky_color', 'fog_color', 'water_color']);
const GRASS_MODIFIERS = new Set(['none', 'dark_forest', 'swamp']);

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Validate editable biome metadata without dropping extension fields. Temperature
 * and downfall may exceed vanilla ranges; colormap sampling clamps them later.
 * Colors are opaque 24-bit RGB integers. Return the original validated object. */
export function parseBiomeMap(value: unknown): BiomeMap {
  if (!record(value)) throw new TypeError('biomes must be an object');
  for (const [name, biome] of Object.entries(value)) {
    if (
      !record(biome) ||
      !Number.isFinite(biome.temperature) ||
      !Number.isFinite(biome.downfall) ||
      !record(biome.effects)
    )
      throw new TypeError(`invalid biome definition: ${name}`);
    const effects = biome.effects;
    for (const field of COLOR_FIELDS) {
      const color = effects[field];
      if (color === undefined && !REQUIRED_COLORS.has(field)) continue;
      if (typeof color !== 'number' || !Number.isInteger(color) || color < 0 || color > 0xffffff)
        throw new TypeError(`invalid biome color: ${name}.${field}`);
    }
    if (
      effects.grass_color_modifier !== undefined &&
      (typeof effects.grass_color_modifier !== 'string' || !GRASS_MODIFIERS.has(effects.grass_color_modifier))
    )
      throw new TypeError(`invalid grass color modifier: ${name}`);
  }
  return value as BiomeMap;
}
