export const TOP_MAP_SCHEMA = 6;
export const TOP_MAP_TILE_BLOCKS = 512;
export const TOP_MAP_MISSING_HEIGHT = -32768;

export type TopMapApproach = 'top' | 'bottom';
export type TopMapLightMode = 'stored-first' | 'rebake';

export interface TopMapRegionManifestEntry {
  x: number;
  z: number;
  hash: string;
}

export interface TopMapRegionSourceEntry extends TopMapRegionManifestEntry {
  empty: boolean;
}

export interface TopMapTileSetManifest {
  tileSizeBlocks: number;
  sampleStride: number;
  colorStride: number;
  lightStride: number;
  colorVersion: number;
  lightVersion: number;
  approach: TopMapApproach;
  lightMode: TopMapLightMode;
  format: 'msgpack';
  regions: TopMapRegionManifestEntry[];
  sources: TopMapRegionSourceEntry[];
}

export interface TopMapDimensionRecord {
  hasTopMap: boolean;
  topMap?: TopMapTileSetManifest;
}

export interface TopMapManifest {
  schema: 6;
  generatedAt: string;
  world: string;
  dimensions: Record<string, TopMapDimensionRecord>;
}

export interface TopMapTilePayload {
  schema: 6;
  kind: 'topmap-region';
  dimension: string;
  approach: TopMapApproach;
  region: { x: number; z: number };
  origin: { x: number; z: number };
  size: { blocks: number; samples: number; colorSamples: number; lightSamples: number };
  sampleStride: number;
  colorStride: number;
  lightStride: number;
  chunks: number;
  minY: number;
  maxY: number;
  heightEncoding: 'int16le';
  colorEncoding: 'rgba8888';
  lightEncoding: 'sky-block-u4';
  heights: Uint8Array;
  colors: Uint8Array;
  lights: Uint8Array;
}

export interface PreparedTopMapTile {
  payload: TopMapTilePayload;
  heights: Int16Array;
  colors: Uint8Array;
  lights: Uint8Array;
}

const PLATFORM_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
function decodeInt16Le(bytes: Uint8Array, count: number): Int16Array {
  if (bytes.byteLength !== count * 2) throw new Error(`bad top-map height payload size: ${bytes.byteLength}`);
  // Msgpack commonly hands us an aligned, standalone buffer. On all mainstream
  // browsers that buffer already has the wire format's little-endian layout,
  // so retain a zero-copy view instead of keeping a second height array for
  // every resident 512x512 tile.
  if (PLATFORM_LITTLE_ENDIAN && bytes.byteOffset % Int16Array.BYTES_PER_ELEMENT === 0) {
    return new Int16Array(bytes.buffer, bytes.byteOffset, count);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

/** Validate a decoded tile and prepare typed views for repeated mesh rebuilds. */
export function prepareTopMapTile(payload: TopMapTilePayload): PreparedTopMapTile {
  const blocks = TOP_MAP_TILE_BLOCKS;
  const validStride = (value: number) => Number.isSafeInteger(value) && value >= 1 && value <= blocks;
  if (
    !payload ||
    !payload.size ||
    !payload.region ||
    !payload.origin ||
    !Number.isSafeInteger(payload.region.x) ||
    !Number.isSafeInteger(payload.region.z) ||
    !Number.isSafeInteger(payload.origin.x) ||
    !Number.isSafeInteger(payload.origin.z) ||
    payload.origin.x !== payload.region.x * blocks ||
    payload.origin.z !== payload.region.z * blocks ||
    !(payload.heights instanceof Uint8Array) ||
    !(payload.colors instanceof Uint8Array) ||
    !(payload.lights instanceof Uint8Array) ||
    !validStride(payload.sampleStride) ||
    !validStride(payload.colorStride) ||
    !validStride(payload.lightStride) ||
    !Number.isSafeInteger(payload.size.samples) ||
    !Number.isSafeInteger(payload.size.colorSamples) ||
    !Number.isSafeInteger(payload.size.lightSamples) ||
    !Number.isFinite(payload.minY) ||
    !Number.isFinite(payload.maxY) ||
    payload.minY > payload.maxY
  ) {
    throw new Error('bad top-map tile payload');
  }
  const heightPixels = payload.size.samples * payload.size.samples;
  const colorPixels = payload.size.colorSamples * payload.size.colorSamples;
  const lightPixels = payload.size.lightSamples * payload.size.lightSamples;
  if (
    payload.schema !== TOP_MAP_SCHEMA ||
    payload.kind !== 'topmap-region' ||
    (payload.approach !== 'top' && payload.approach !== 'bottom') ||
    payload.heightEncoding !== 'int16le' ||
    payload.colorEncoding !== 'rgba8888' ||
    payload.lightEncoding !== 'sky-block-u4' ||
    payload.size.blocks !== TOP_MAP_TILE_BLOCKS ||
    payload.size.samples !== Math.floor(payload.size.blocks / payload.sampleStride) ||
    payload.size.colorSamples !== Math.floor(payload.size.blocks / payload.colorStride) ||
    payload.size.lightSamples !== Math.floor(payload.size.blocks / payload.lightStride) ||
    payload.heights.byteLength !== heightPixels * 2 ||
    payload.colors.byteLength !== colorPixels * 4 ||
    payload.lights.byteLength !== lightPixels * 2
  ) {
    throw new Error(`bad top-map tile payload for region ${payload.region.x},${payload.region.z}`);
  }
  return {
    payload,
    heights: decodeInt16Le(payload.heights, heightPixels),
    colors:
      payload.colors.byteOffset === 0 && payload.colors.byteLength === payload.colors.buffer.byteLength
        ? payload.colors
        : new Uint8Array(payload.colors),
    lights:
      payload.lights.byteOffset === 0 && payload.lights.byteLength === payload.lights.buffer.byteLength
        ? payload.lights
        : new Uint8Array(payload.lights),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Check the fields that the capabilities and tile endpoints dereference. */
export function parseTopMapManifest(value: unknown): TopMapManifest | null {
  if (!isRecord(value) || value.schema !== TOP_MAP_SCHEMA || !isRecord(value.dimensions)) return null;
  for (const dimension of Object.values(value.dimensions)) {
    if (!isRecord(dimension) || typeof dimension.hasTopMap !== 'boolean') return null;
    const topMap = dimension.topMap;
    if (dimension.hasTopMap && !isRecord(topMap)) return null;
    if (topMap !== undefined) {
      if (!isRecord(topMap) || !Array.isArray(topMap.regions)) return null;
      for (const region of topMap.regions) {
        if (!isRecord(region) || !Number.isSafeInteger(region.x) || !Number.isSafeInteger(region.z)) return null;
      }
    }
  }
  return value as unknown as TopMapManifest;
}
