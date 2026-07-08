import fs from 'node:fs/promises';
import path from 'node:path';
import { encode } from '@msgpack/msgpack';
import {
  computeColumnLight,
  sampleTopMapSurface,
  TOP_MAP_MISSING_HEIGHT,
  TOP_MAP_SCHEMA,
  TOP_MAP_TILE_BLOCKS,
  type BlockInfo,
  type BlockStateRef,
  type Rgb,
  type TopMapApproach,
  type TopMapLightMode,
  type TopMapManifest,
  type TopMapRegionManifestEntry as RegionManifestEntry,
  type TopMapRegionSourceEntry as RegionSourceEntry,
  type TopMapTileSetManifest,
} from '@violet-map/core';
import {
  argsReader,
  ensureLight,
  defaultTopMapOut,
  ensureDir,
  findRegionFiles,
  infoGetter,
  loadBlockInfo,
  loadBiomeColors,
  loadRegionColumns,
  makeColorOf,
  makeTextureColorOf,
  numberArg,
  parseDim,
  resolveAssetDirs,
  resolvePath,
  sha1Bytes,
  stateColor,
  type ColumnEntry,
  type RegionFile,
} from './common.js';

interface BakeOptions {
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
const TOPMAP_COLOR_VERSION = 3;
const TOPMAP_LIGHT_VERSION = 1;

function usage(): string {
  return `Usage:
  vm-assets bake-topmap <world> [--dim <id>] [--out <dir>] [--limit <regions>] [--block-info <file>] [--biomes <file>] [--assets-dir <dir[,dir]>] [--sample-stride <blocks>] [--color-stride <blocks>] [--light-stride <blocks>] [--approach <top|bottom>] [--light-mode <stored-first|rebake>] [--no-sky]`;
}

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

function parseOptions(args: string[]): BakeOptions {
  const reader = argsReader(args);
  const world = args.find((arg) => !arg.startsWith('-'));
  if (!world) throw new Error(`missing world path\n${usage()}`);
  const resolvedWorld = resolvePath(world);
  return {
    world: resolvedWorld,
    dim: parseDim(reader.get('--dim', 'minecraft:overworld')),
    out: resolvePath(reader.get('--out') ?? defaultTopMapOut(resolvedWorld)),
    limit: Math.floor(numberArg(reader.get('--limit'), Infinity, 1)),
    hasSkyLight: !reader.flag('--no-sky'),
    blockInfo: reader.get('--block-info'),
    biomes: reader.get('--biomes'),
    assetDirs: resolveAssetDirs(reader.get('--assets-dir')),
    sampleStride: Math.floor(numberArg(reader.get('--sample-stride'), DEFAULT_SAMPLE_STRIDE, 1)),
    colorStride: Math.floor(numberArg(reader.get('--color-stride'), DEFAULT_COLOR_STRIDE, 1)),
    lightStride: Math.floor(numberArg(reader.get('--light-stride'), numberArg(reader.get('--color-stride'), DEFAULT_COLOR_STRIDE, 1), 1)),
    approach: parseApproach(reader.get('--approach')),
    lightMode: parseLightMode(reader.get('--light-mode')),
  };
}

function dimOutDir(out: string, dim: string): string {
  return path.join(out, encodeURIComponent(dim), 'topmap');
}

function tileFile(out: string, dim: string, rx: number, rz: number): string {
  return path.join(dimOutDir(out, dim), `r.${rx}.${rz}.msgpack`);
}

async function readManifest(out: string, world: string): Promise<TopMapManifest> {
  const file = path.join(out, 'manifest.json');
  try {
    const manifest = JSON.parse(await fs.readFile(file, 'utf8')) as TopMapManifest;
    if (manifest.schema === TOP_MAP_SCHEMA && manifest.dimensions && typeof manifest.dimensions === 'object') return manifest;
  } catch {
    // Create a fresh manifest below.
  }
  return {
    schema: TOP_MAP_SCHEMA,
    generatedAt: new Date().toISOString(),
    world: path.basename(world),
    dimensions: {},
  };
}

async function writeManifest(out: string, manifest: TopMapManifest) {
  manifest.generatedAt = new Date().toISOString();
  await ensureDir(out);
  await fs.writeFile(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function updateDimensionManifest(
  manifest: TopMapManifest,
  dim: string,
  patch: Partial<TopMapManifest['dimensions'][string]>,
) {
  const previous = manifest.dimensions[dim] ?? { hasTopMap: false };
  const next = { ...previous, ...patch };
  next.hasTopMap = !!next.topMap && next.topMap.regions.length > 0;
  manifest.dimensions[dim] = next;
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

async function writeMsgpack(file: string, value: unknown) {
  const bytes = encode(value);
  await fs.writeFile(file, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

interface BakeRegionResult {
  entry: RegionManifestEntry | null;
  source: RegionSourceEntry;
  wrote: boolean;
  skipped: boolean;
  removed: boolean;
  empty: boolean;
}

function bakeColumnLight(
  entry: ColumnEntry,
  opts: BakeOptions,
  infoOf: (name: string) => BlockInfo,
) {
  if (opts.lightMode === 'rebake') {
    computeColumnLight(entry.col, infoOf, opts.hasSkyLight, { writeSky: opts.hasSkyLight, writeBlock: true });
    entry.litSky = !opts.hasSkyLight || entry.col.hasStoredSkyLight;
    entry.litBlock = entry.col.hasStoredBlockLight;
    return;
  }
  ensureLight(entry, infoOf, opts.hasSkyLight);
}

async function bakeTopMapRegion(
  region: RegionFile,
  opts: BakeOptions,
  infoOf: (name: string) => BlockInfo,
  colorOf: ((state: BlockStateRef, biome: string) => Rgb) | null,
  previous: RegionManifestEntry | undefined,
  previousSource: RegionSourceEntry | undefined,
  force: boolean,
): Promise<BakeRegionResult> {
  if (TOP_MAP_TILE_BLOCKS % opts.sampleStride !== 0) {
    throw new Error(`sample stride must evenly divide ${TOP_MAP_TILE_BLOCKS}: ${opts.sampleStride}`);
  }
  if (TOP_MAP_TILE_BLOCKS % opts.colorStride !== 0) {
    throw new Error(`color stride must evenly divide ${TOP_MAP_TILE_BLOCKS}: ${opts.colorStride}`);
  }
  if (TOP_MAP_TILE_BLOCKS % opts.lightStride !== 0) {
    throw new Error(`light stride must evenly divide ${TOP_MAP_TILE_BLOCKS}: ${opts.lightStride}`);
  }
  const sourceBytes = new Uint8Array(await fs.readFile(region.file));
  const hash = sha1Bytes(sourceBytes);
  const outFile = tileFile(opts.out, opts.dim, region.rx, region.rz);
  if (!force && previousSource?.hash === hash && previousSource.empty) {
    if (previous) await fs.rm(outFile, { force: true });
    return {
      entry: null,
      source: previousSource,
      wrote: false,
      skipped: true,
      removed: previous !== undefined,
      empty: true,
    };
  }
  if (!force && previousSource?.hash === hash && previous?.hash === hash) {
    try {
      const stat = await fs.stat(outFile);
      if (stat.isFile() && stat.size > 0) {
        return {
          entry: previous,
          source: previousSource,
          wrote: false,
          skipped: true,
          removed: false,
          empty: false,
        };
      }
    } catch {
      // Missing tile is rebuilt below even if the source hash is unchanged.
    }
  }
  const entries = await loadRegionColumns(region.file);
  if (!entries.size) {
    await fs.rm(outFile, { force: true });
    return {
      entry: null,
      source: { x: region.rx, z: region.rz, hash, empty: true },
      wrote: false,
      skipped: false,
      removed: previous !== undefined,
      empty: true,
    };
  }
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
  const fallbackColorOf = colorOf ?? ((state: BlockStateRef) => stateColor(state));

  for (const entry of entries.values()) bakeColumnLight(entry, opts, infoOf);

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
        const top = sampleTopMapSurface(col, x, z, { approach: opts.approach, infoOf, colorOf: fallbackColorOf });
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
  if (!Number.isFinite(minY)) {
    await fs.rm(outFile, { force: true });
    return {
      entry: null,
      source: { x: region.rx, z: region.rz, hash, empty: true },
      wrote: false,
      skipped: false,
      removed: previous !== undefined,
      empty: true,
    };
  }

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

  const outDir = dimOutDir(opts.out, opts.dim);
  await ensureDir(outDir);
  await writeMsgpack(outFile, payload);
  return {
    entry: { x: region.rx, z: region.rz, hash },
    source: { x: region.rx, z: region.rz, hash, empty: false },
    wrote: true,
    skipped: false,
    removed: false,
    empty: false,
  };
}

async function selectRegions(opts: BakeOptions): Promise<RegionFile[]> {
  const regions = await findRegionFiles(opts.world, opts.dim);
  return Number.isFinite(opts.limit) ? regions.slice(0, opts.limit) : regions;
}

export async function runBakeTopMap(args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    return;
  }
  const opts = parseOptions(args);
  const blockInfo = await loadBlockInfo(opts.blockInfo);
  const infoOf = infoGetter(blockInfo);
  const biomeColors = await loadBiomeColors(opts.assetDirs, opts.biomes);
  const colorOf = await makeTextureColorOf(opts.assetDirs, infoOf, biomeColors) ?? (blockInfo ? makeColorOf(infoOf) : null);
  const regions = await selectRegions(opts);
  console.log(`bake-topmap world=${opts.world} dim=${opts.dim} regions=${regions.length} out=${opts.out}`);
  console.log(`  approach=${opts.approach} light=${opts.lightMode}${opts.hasSkyLight ? '' : ' no-sky'}`);
  console.log(`  assets=${opts.assetDirs.join(', ')}`);
  console.log(`  biome colors=${biomeColors ? 'enabled' : 'fallback'}`);
  const manifest = await readManifest(opts.out, opts.world);
  const previousTopMap = manifest.dimensions[opts.dim]?.topMap;
  const force = previousTopMap?.format !== 'msgpack'
    || previousTopMap.tileSizeBlocks !== TOP_MAP_TILE_BLOCKS
    || previousTopMap.sampleStride !== opts.sampleStride
    || previousTopMap.colorStride !== opts.colorStride
    || previousTopMap.lightStride !== opts.lightStride
    || previousTopMap.colorVersion !== TOPMAP_COLOR_VERSION
    || previousTopMap.lightVersion !== TOPMAP_LIGHT_VERSION
    || previousTopMap.approach !== opts.approach
    || previousTopMap.lightMode !== opts.lightMode;
  const previousByKey = new Map<string, RegionManifestEntry>((force ? [] : previousTopMap?.regions ?? [])
    .map((region) => [`${region.x},${region.z}`, region] as const));
  const previousSources = previousTopMap?.sources ?? [];
  const previousSourceByKey = new Map<string, RegionSourceEntry>((force ? [] : previousSources)
    .map((region) => [`${region.x},${region.z}`, region] as const));
  const currentKeys = new Set<string>(regions.map((region) => `${region.rx},${region.rz}`));
  const nextRegions: RegionManifestEntry[] = [];
  const nextSources: RegionSourceEntry[] = [];
  let wrote = 0;
  let skipped = 0;
  let empty = 0;
  let removed = 0;

  await ensureDir(dimOutDir(opts.out, opts.dim));
  for (const previous of previousSources.length ? previousSources : previousTopMap?.regions ?? []) {
    const key = `${previous.x},${previous.z}`;
    if (!force && currentKeys.has(key)) continue;
    await fs.rm(tileFile(opts.out, opts.dim, previous.x, previous.z), { force: true });
    removed++;
  }
  for (const [index, region] of regions.entries()) {
    const key = `${region.rx},${region.rz}`;
    const result = await bakeTopMapRegion(
      region,
      opts,
      infoOf,
      colorOf,
      previousByKey.get(key),
      previousSourceByKey.get(key),
      force,
    );
    if (result.entry) nextRegions.push(result.entry);
    nextSources.push(result.source);
    if (result.wrote) wrote++;
    if (result.skipped) skipped++;
    if (result.empty) empty++;
    if (result.removed) removed++;
    const action = result.skipped ? 'skip' : result.empty ? 'empty' : result.wrote ? 'write' : 'drop';
    console.log(`  ${index + 1}/${regions.length} ${action} r.${region.rx}.${region.rz}`);
  }
  updateDimensionManifest(manifest, opts.dim, {
    topMap: {
      tileSizeBlocks: TOP_MAP_TILE_BLOCKS,
      sampleStride: opts.sampleStride,
      colorStride: opts.colorStride,
      lightStride: opts.lightStride,
      colorVersion: TOPMAP_COLOR_VERSION,
      lightVersion: TOPMAP_LIGHT_VERSION,
      approach: opts.approach,
      lightMode: opts.lightMode,
      format: 'msgpack',
      regions: nextRegions,
      sources: nextSources,
    } satisfies TopMapTileSetManifest,
  });
  await writeManifest(opts.out, manifest);
  console.log(`wrote ${path.join(opts.out, 'manifest.json')} (${wrote} updated, ${skipped} unchanged, ${empty} empty, ${removed} removed)`);
}
