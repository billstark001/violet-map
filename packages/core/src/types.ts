export type Direction = 'down' | 'up' | 'north' | 'south' | 'west' | 'east';
export type RenderLayer = 'opaque' | 'opaqueTiled' | 'cutout' | 'translucent';
export type TintType = 'none' | 'grass' | 'foliage' | 'water' | 'redstone' | 'stem' | 'attachedStem';

export interface BlockStateRef {
  name: string;
  properties: Record<string, string>;
}

export interface FluidDef {
  texture: string;
  tint: TintType;
  layer?: RenderLayer;
}

export interface BlockInfo {
  occludes: boolean;
  emit: number;
  filter: number;
  layer: RenderLayer;
  tint: TintType;
  fixedTint?: number;
  fluid?: FluidDef;
  waterlogged?: boolean;
}
export type BlockInfoMap = Record<string, BlockInfo>;

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

export interface AtlasRect { u0: number; v0: number; u1: number; v1: number }
export type AtlasIndex = Record<string, AtlasRect>;

export interface MeshBuffers {
  positions: Uint16Array;
  uvs?: Uint16Array;
  atlasRects?: Uint16Array;
  colors: Uint8Array;
  lights: Uint8Array;
  indices: Uint16Array | Uint32Array;
  bounds?: { min: [number, number, number]; max: [number, number, number] };
}
export type SectionMeshes = Partial<Record<RenderLayer, MeshBuffers>>;
export type TextureAlphaMap = Record<string, boolean>;

export interface AssetBundle {
  blockstates: Record<string, unknown>;
  models: Record<string, BlockModelJson>;
}

export interface BlockModelJson {
  parent?: string;
  ambientocclusion?: boolean;
  textures?: Record<string, unknown>;
  elements?: ModelElementJson[];
}
export interface ModelElementJson {
  from: [number, number, number];
  to: [number, number, number];
  rotation?: { origin: [number, number, number]; axis: 'x' | 'y' | 'z'; angle: number; rescale?: boolean };
  shade?: boolean;
  faces: Partial<Record<Direction, ModelFaceJson>>;
}
export interface ModelFaceJson {
  uv?: [number, number, number, number];
  texture: string;
  cullface?: Direction;
  rotation?: number;
  tintindex?: number;
}

export interface BlockStateVariantJson {
  model: string;
  x?: number;
  y?: number;
  uvlock?: boolean;
  weight?: number;
}

export const DIRECTIONS: Direction[] = ['down', 'up', 'north', 'south', 'west', 'east'];
export const DIR_VEC: Record<Direction, [number, number, number]> = {
  down: [0, -1, 0], up: [0, 1, 0],
  north: [0, 0, -1], south: [0, 0, 1],
  west: [-1, 0, 0], east: [1, 0, 0],
};

export function normalizeId(id: string): string {
  return id.includes(':') ? id : `minecraft:${id}`;
}
