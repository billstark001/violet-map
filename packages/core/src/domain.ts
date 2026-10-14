export interface BlockStateRef {
  name: string;
  properties: Record<string, string>;
}

export interface BiomeDef {
  temperature: number;
  downfall: number;
  effects: {
    sky_color: number;
    fog_color: number;
    water_color: number;
    grass_color?: number;
    foliage_color?: number;
    grass_color_modifier?: 'none' | 'dark_forest' | 'swamp';
  };
}
export type BiomeMap = Record<string, BiomeDef>;

export interface DimensionDef {
  hasSkyLight: boolean;
  ambientLight: number;
  sky: 'normal' | 'nether' | 'end';
  defaultBiome: string;
}
export type DimensionMap = Record<string, DimensionDef>;

export function normalizeId(id: string): string {
  return id.includes(':') ? id : `minecraft:${id}`;
}
export * from './world.js';
export * from './dimensionId.js';
