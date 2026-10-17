export type Direction = 'down' | 'up' | 'north' | 'south' | 'west' | 'east';

export type RenderLayer =
  | 'opaque'
  | 'opaqueTiled'
  | 'cutout'
  | 'translucent'
  /** Resource-driven block entities / entities. Kept separate so the viewer
   * can apply its full-chunk radius policy without affecting terrain. */
  | 'specialOpaque'
  | 'specialCutout'
  | 'specialTranslucent';

export type TintType = 'none' | 'grass' | 'foliage' | 'water' | 'redstone' | 'stem' | 'attachedStem';

export interface FluidDef {
  /** Sprite used by a source/still fluid surface. */
  texture: string;
  /** Sprite used by moving surfaces and every exposed fluid side. */
  flowTexture?: string;
  tint: TintType;
  layer?: RenderLayer;
}

export interface BlockInfo {
  /** Whether a geometrically solid, opaque model can block light and visibility. */
  occludes: boolean;
  /** Remove touching faces against the same block id even when its texture has
   * alpha (glass and ice). Omit for porous blocks such as leaves. Model face
   * coverage is still required; this does not make the block an occluder. */
  cullSameBlock?: boolean;
  emit: number;
  filter: number;
  layer: RenderLayer;
  tint: TintType;
  fixedTint?: number;
  fluid?: FluidDef;
  waterlogged?: boolean;
}

export type BlockInfoMap = Record<string, BlockInfo>;

/** One atlas slot. Animated textures keep the first frame here and expose the
 * complete, already-resolved animation sequence through `animation`. */
export interface AtlasRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  animation?: AtlasAnimation;
}

export interface AtlasAnimation {
  /** Frame rectangles in playback order. */
  frames: AtlasFrameRect[];
  /** Minecraft ticks for each frame. */
  times: number[];
  interpolate?: boolean;
}

export interface AtlasFrameRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export type AtlasIndex = Record<string, AtlasRect>;

export type TextureAlphaMap = Record<string, boolean>;

export interface AssetBundle {
  blockstates: Record<string, unknown>;
  models: Record<string, BlockModelJson>;
  /** Resource-pack supplied renderer registrations. No ids are interpreted by
   * the renderer itself; an object is rendered only when it has an entry here. */
  renderers?: RendererDefinitions;
  /** Parsed `.png.mcmeta` files, used while assembling animated atlas tiles. */
  textureAnimations?: TextureAnimationMap;
}

export interface TextureAnimationFrameDef {
  index: number;
  time?: number;
}

export interface TextureAnimationDef {
  frametime?: number;
  frames?: TextureAnimationFrameDef[];
  interpolate?: boolean;
}

export type TextureAnimationMap = Record<string, TextureAnimationDef>;

/**
 * A declarative model registration stored in
 * `assets/<namespace>/violet_map/renderers.json`. `model` is an ordinary Java
 * model JSON (the same `elements`/`textures` format used by block models), so
 * packs can add entity and block-entity geometry without JavaScript changes.
 */
export interface RendererModelDef {
  model: string;
  layer?: 'opaque' | 'cutout' | 'translucent';
  /** Replace every texture referenced by the model for this instance. Useful
   * for vanilla block-entity models whose geometry is shared by many woods or
   * chest variants. */
  texture?: string;
  /** State block id -> texture replacement. Kept in renderer resources so
   * the mesher never needs a hard-coded list of Minecraft wood types. */
  textureByBlock?: Record<string, string>;
  offset?: [number, number, number];
  scale?: [number, number, number];
  /** A fixed quarter-turn, or a state-property name whose value is looked up
   * in `rotationY.values`. */
  rotationY?: number | { property: string; values: Record<string, number> };
  /** Entity definitions can opt in to the entity's saved yaw. */
  useEntityYaw?: boolean;
  /** First matching `key=value[,key=value]` entry overlays this definition. */
  variants?: Record<string, Partial<RendererModelDef>>;
}

export interface RendererDefinitions {
  blockEntities?: Record<string, RendererModelDef>;
  entities?: Record<string, RendererModelDef>;
}

export interface BlockModelJson {
  parent?: string;
  ambientocclusion?: boolean;
  /** Pixel dimensions for UVs. Vanilla block models use the implicit 16×16
   * grid; resource-driven entity models may instead address a 64×64 skin. */
  texture_size?: [number, number];
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
  down: [0, -1, 0],
  up: [0, 1, 0],
  north: [0, 0, -1],
  south: [0, 0, 1],
  west: [-1, 0, 0],
  east: [1, 0, 0],
};
