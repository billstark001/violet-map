import { encode } from '@msgpack/msgpack';
import type { BlockInfo } from '@violet-map/core/assets';
import type { BlockStateRef, ChunkColumn } from '@violet-map/core/domain';
import {
  TOP_MAP_MISSING_HEIGHT,
  TOP_MAP_SCHEMA,
  TOP_MAP_TILE_BLOCKS,
  type TopMapApproach,
} from '@violet-map/core/formats/top-map';

type Rgb = readonly [number, number, number];

export interface TopMapBakeOptions {
  dim: string;
  sampleStride: number;
  colorStride: number;
  lightStride: number;
  approach: TopMapApproach;
  hasSkyLight: boolean;
}

export interface TopMapColumn {
  col: ChunkColumn;
  litSky: boolean;
  litBlock: boolean;
}

export interface TopMapRenderHooks {
  light(entry: TopMapColumn): void;
  missingColor(state: BlockStateRef, biome: string): Rgb;
  sample(
    col: ChunkColumn,
    x: number,
    z: number,
    options: {
      approach: TopMapApproach;
      infoOf: (name: string) => BlockInfo;
      colorOf: (state: BlockStateRef, biome: string) => Rgb;
    },
  ): { y: number; color: Rgb | null; sky: number; block: number } | null;
}

function shouldReplaceHeight(current: number, next: number, approach: TopMapApproach): boolean {
  if (current <= TOP_MAP_MISSING_HEIGHT) return true;
  return approach === 'top' ? next > current : next < current;
}

function writeRgbaColor(colors: Uint8Array, index: number, color: Rgb | null) {
  const offset = index * 4;
  if (!color) {
    colors[offset] = 0;
    colors[offset + 1] = 0;
    colors[offset + 2] = 0;
    colors[offset + 3] = 0;
    return;
  }
  colors[offset] = Math.round(color[0] * 255);
  colors[offset + 1] = Math.round(color[1] * 255);
  colors[offset + 2] = Math.round(color[2] * 255);
  colors[offset + 3] = 255;
}

function writeLight(lights: Uint8Array, index: number, sky: number, block: number, hasSkyLight: boolean) {
  const offset = index * 2;
  lights[offset] = hasSkyLight ? Math.min(15, Math.max(0, Math.round(sky))) : 0;
  lights[offset + 1] = Math.min(15, Math.max(0, Math.round(block)));
}

function bytesOf(values: Int16Array | Uint8Array): Uint8Array {
  return new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
}

/** Deterministic tile generator; the CLI injects renderer capabilities without a package dependency. */
export function generateTopMapTile(
  entries: ReadonlyMap<string, TopMapColumn>,
  region: { rx: number; rz: number },
  opts: TopMapBakeOptions,
  infoOf: (name: string) => BlockInfo,
  colorOf: ((state: BlockStateRef, biome: string) => Rgb) | null,
  hooks: TopMapRenderHooks,
): Uint8Array | null {
  const samples = TOP_MAP_TILE_BLOCKS / opts.sampleStride;
  const colorSamples = TOP_MAP_TILE_BLOCKS / opts.colorStride;
  const lightSamples = TOP_MAP_TILE_BLOCKS / opts.lightStride;
  const heights = new Int16Array(samples * samples);
  const colorHeights = new Int16Array(colorSamples * colorSamples);
  const lightHeights = new Int16Array(lightSamples * lightSamples);
  const colors = new Uint8Array(colorSamples * colorSamples * 4);
  const lights = new Uint8Array(lightSamples * lightSamples * 2);
  heights.fill(TOP_MAP_MISSING_HEIGHT);
  colorHeights.fill(TOP_MAP_MISSING_HEIGHT);
  lightHeights.fill(TOP_MAP_MISSING_HEIGHT);
  let minY = Infinity;
  let maxY = -Infinity;
  let chunks = 0;
  const fallbackColorOf = colorOf ?? hooks.missingColor;

  for (const entry of entries.values()) hooks.light(entry);

  for (const entry of entries.values()) {
    chunks++;
    const col = entry.col;
    const chunkLocalX = (col.x - region.rx * 32) * 16;
    const chunkLocalZ = (col.z - region.rz * 32) * 16;
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const tileX = chunkLocalX + x;
        const tileZ = chunkLocalZ + z;
        if (tileX < 0 || tileX >= TOP_MAP_TILE_BLOCKS || tileZ < 0 || tileZ >= TOP_MAP_TILE_BLOCKS) continue;
        const top = hooks.sample(col, x, z, { approach: opts.approach, infoOf, colorOf: fallbackColorOf });
        if (!top) continue;
        const sampleX = Math.floor(tileX / opts.sampleStride);
        const sampleZ = Math.floor(tileZ / opts.sampleStride);
        const i = sampleZ * samples + sampleX;
        if (shouldReplaceHeight(heights[i], top.y, opts.approach)) heights[i] = top.y;
        const colorX = Math.floor(tileX / opts.colorStride);
        const colorZ = Math.floor(tileZ / opts.colorStride);
        const colorIndex = colorZ * colorSamples + colorX;
        if (shouldReplaceHeight(colorHeights[colorIndex], top.y, opts.approach)) {
          colorHeights[colorIndex] = top.y;
          writeRgbaColor(colors, colorIndex, top.color);
        }
        const lightX = Math.floor(tileX / opts.lightStride);
        const lightZ = Math.floor(tileZ / opts.lightStride);
        const lightIndex = lightZ * lightSamples + lightX;
        if (shouldReplaceHeight(lightHeights[lightIndex], top.y, opts.approach)) {
          lightHeights[lightIndex] = top.y;
          writeLight(lights, lightIndex, top.sky, top.block, opts.hasSkyLight);
        }
      }
    }
  }

  for (const y of heights) {
    if (y <= -32768) continue;
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minY)) return null;

  const payload = {
    schema: TOP_MAP_SCHEMA,
    kind: 'topmap-region',
    dimension: opts.dim,
    approach: opts.approach,
    region: { x: region.rx, z: region.rz },
    origin: { x: region.rx * TOP_MAP_TILE_BLOCKS, z: region.rz * TOP_MAP_TILE_BLOCKS },
    size: { blocks: TOP_MAP_TILE_BLOCKS, samples, colorSamples, lightSamples },
    sampleStride: opts.sampleStride,
    colorStride: opts.colorStride,
    lightStride: opts.lightStride,
    chunks,
    minY: Number.isFinite(minY) ? minY : 0,
    maxY: Number.isFinite(maxY) ? maxY : 0,
    heightEncoding: 'int16le',
    colorEncoding: 'rgba8888',
    lightEncoding: 'sky-block-u4',
    heights: bytesOf(heights),
    colors,
    lights,
  };

  return encode(payload);
}
