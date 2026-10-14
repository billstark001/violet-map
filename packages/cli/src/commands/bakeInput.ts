import { resolvePath, parseDim, resolveAssetDirs } from './paths.js';
import { defaultTopMapOut } from './worldInput.js';
import { TOP_MAP_TILE_BLOCKS, type TopMapApproach, type TopMapLightMode } from '@violet-map/core/formats/top-map';

export interface BakeOptions {
  world: string;
  dim: string;
  out: string;
  limit: number;
  hasSkyLight: boolean;
  blockInfo?: string;
  biomes?: string;
  assetDirs: string[];
  sampleStride: number;
  colorStride: number;
  lightStride: number;
  approach: TopMapApproach;
  lightMode: TopMapLightMode;
}

const DEFAULT_SAMPLE_STRIDE = 4;
const DEFAULT_COLOR_STRIDE = 1;

function parseApproach(value: string | undefined): TopMapApproach {
  if (!value || value === 'top') return 'top';
  if (value === 'bottom') return 'bottom';
  throw new Error(`bad --approach: ${value}`);
}

function parseLightMode(value: string | undefined): TopMapLightMode {
  if (!value || value === 'stored-first') return 'stored-first';
  if (value === 'rebake') return 'rebake';
  throw new Error(`bad --light-mode: ${value}`);
}

export interface BakeInput {
  world: string;
  dim?: string;
  out?: string;
  limit?: number;
  sky?: boolean;
  blockInfo?: string;
  biomes?: string;
  assetsDir?: string;
  sampleStride?: number;
  colorStride?: number;
  lightStride?: number;
  approach?: TopMapApproach;
  lightMode?: TopMapLightMode;
}
export function bakeOptions(input: BakeInput): BakeOptions {
  const resolvedWorld = resolvePath(input.world);
  const options: BakeOptions = {
    world: resolvedWorld,
    dim: parseDim(input.dim),
    out: resolvePath(input.out ?? defaultTopMapOut(resolvedWorld)),
    limit: input.limit ?? Infinity,
    hasSkyLight: input.sky !== false,
    blockInfo: input.blockInfo,
    biomes: input.biomes,
    assetDirs: resolveAssetDirs(input.assetsDir),
    sampleStride: input.sampleStride ?? DEFAULT_SAMPLE_STRIDE,
    colorStride: input.colorStride ?? DEFAULT_COLOR_STRIDE,
    lightStride: input.lightStride ?? input.colorStride ?? DEFAULT_COLOR_STRIDE,
    approach: parseApproach(input.approach),
    lightMode: parseLightMode(input.lightMode),
  };
  for (const [label, stride] of [
    ['sample', options.sampleStride],
    ['color', options.colorStride],
    ['light', options.lightStride],
  ] as const) {
    if (TOP_MAP_TILE_BLOCKS % stride !== 0)
      throw new Error(`${label} stride must evenly divide ${TOP_MAP_TILE_BLOCKS}: ${stride}`);
  }
  return options;
}
