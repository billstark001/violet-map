import fs from 'node:fs/promises';
import path from 'node:path';
import { encode } from '@msgpack/msgpack';
import {
  AIR_NAMES,
  type BlockStateRef,
  type Rgb,
} from '@violet-map/core';
import {
  argsReader,
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
  type RegionFile,
} from './common.js';

interface RegionManifestEntry {
  x: number;
  z: number;
  hash: string;
}

interface RegionSourceEntry extends RegionManifestEntry {
  empty: boolean;
}

interface TileSetManifest {
  tileSizeBlocks: number;
  sampleStride: number;
  colorStride: number;
  colorVersion: number;
  format: 'msgpack';
  regions: RegionManifestEntry[];
  sources: RegionSourceEntry[];
}

interface DimensionManifest {
  hasTopMap: boolean;
  hasHeightmap: boolean;
  heightmap?: TileSetManifest;
}

interface TopMapManifest {
  schema: 5;
  generatedAt: string;
  world: string;
  dimensions: Record<string, DimensionManifest>;
}

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
}

const TILE_BLOCKS = 512;
const DEFAULT_SAMPLE_STRIDE = 4;
const DEFAULT_COLOR_STRIDE = 1;
const HEIGHTMAP_COLOR_VERSION = 2;
const TOP_MAP_SCHEMA = 5;

function usage(): string {
  return `Usage:
  vm-assets bake-heightmap <world> [--dim <id>] [--out <dir>] [--limit <regions>] [--block-info <file>] [--biomes <file>] [--assets-dir <dir[,dir]>] [--sample-stride <blocks>] [--color-stride <blocks>] [--no-sky]`;
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
  };
}

function dimOutDir(out: string, dim: string): string {
  return path.join(out, encodeURIComponent(dim), 'heightmap');
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
  patch: Partial<DimensionManifest>,
) {
  const previous = manifest.dimensions[dim] ?? { hasTopMap: false, hasHeightmap: false };
  const next = { ...previous, ...patch };
  next.hasTopMap = next.hasHeightmap;
  manifest.dimensions[dim] = next;
}

function topBlock(col: { minY: number; heightAt(x: number, z: number): number; getBlock(x: number, y: number, z: number): BlockStateRef }, x: number, z: number): { y: number; state: BlockStateRef | null } {
  for (let y = col.heightAt(x, z) - 1; y >= col.minY; y--) {
    const state = col.getBlock(x, y, z);
    if (!AIR_NAMES.has(state.name)) return { y, state };
  }
  return { y: col.minY, state: null };
}

function writeRgba(
  colors: Uint8Array,
  index: number,
  state: BlockStateRef | null,
  biome: string,
  colorOf: ((state: BlockStateRef, biome: string) => Rgb) | null,
) {
  const offset = index * 4;
  if (!state) {
    colors[offset] = 0;
    colors[offset + 1] = 0;
    colors[offset + 2] = 0;
    colors[offset + 3] = 0;
    return;
  }
  const color = colorOf?.(state, biome) ?? stateColor(state);
  colors[offset] = Math.round(color[0] * 255);
  colors[offset + 1] = Math.round(color[1] * 255);
  colors[offset + 2] = Math.round(color[2] * 255);
  colors[offset + 3] = 255;
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

async function bakeHeightmapRegion(
  region: RegionFile,
  opts: BakeOptions,
  colorOf: ((state: BlockStateRef, biome: string) => Rgb) | null,
  previous: RegionManifestEntry | undefined,
  previousSource: RegionSourceEntry | undefined,
  force: boolean,
): Promise<BakeRegionResult> {
  if (TILE_BLOCKS % opts.sampleStride !== 0) {
    throw new Error(`sample stride must evenly divide ${TILE_BLOCKS}: ${opts.sampleStride}`);
  }
  if (TILE_BLOCKS % opts.colorStride !== 0) {
    throw new Error(`color stride must evenly divide ${TILE_BLOCKS}: ${opts.colorStride}`);
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
  const samples = TILE_BLOCKS / opts.sampleStride;
  const colorSamples = TILE_BLOCKS / opts.colorStride;
  const heights = new Int16Array(samples * samples);
  const colorHeights = new Int16Array(colorSamples * colorSamples);
  const colors = new Uint8Array(colorSamples * colorSamples * 4);
  heights.fill(-32768);
  colorHeights.fill(-32768);
  let minY = Infinity;
  let maxY = -Infinity;
  let chunks = 0;

  for (const entry of entries.values()) {
    chunks++;
    const col = entry.col;
    const chunkLocalX = (col.x - region.rx * 32) * 16;
    const chunkLocalZ = (col.z - region.rz * 32) * 16;
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const tileX = chunkLocalX + x;
        const tileZ = chunkLocalZ + z;
        if (tileX < 0 || tileX >= TILE_BLOCKS || tileZ < 0 || tileZ >= TILE_BLOCKS) continue;
        const top = topBlock(col, x, z);
        if (!top.state) continue;
        const sampleX = Math.floor(tileX / opts.sampleStride);
        const sampleZ = Math.floor(tileZ / opts.sampleStride);
        const i = sampleZ * samples + sampleX;
        if (top.y > heights[i]) heights[i] = top.y;
        const colorX = Math.floor(tileX / opts.colorStride);
        const colorZ = Math.floor(tileZ / opts.colorStride);
        const colorIndex = colorZ * colorSamples + colorX;
        if (top.y > colorHeights[colorIndex]) {
          colorHeights[colorIndex] = top.y;
          writeRgba(colors, colorIndex, top.state, col.getBiome(x, top.y, z), colorOf);
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
    kind: 'heightmap-region',
    dimension: opts.dim,
    region: { x: region.rx, z: region.rz },
    origin: { x: region.rx * TILE_BLOCKS, z: region.rz * TILE_BLOCKS },
    size: { blocks: TILE_BLOCKS, samples, colorSamples },
    sampleStride: opts.sampleStride,
    colorStride: opts.colorStride,
    chunks,
    minY: Number.isFinite(minY) ? minY : 0,
    maxY: Number.isFinite(maxY) ? maxY : 0,
    heightEncoding: 'int16le',
    colorEncoding: 'rgba8888',
    heights: bytesOf(heights),
    colors,
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

export async function runBakeHeightmap(args: string[]) {
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
  console.log(`bake-heightmap world=${opts.world} dim=${opts.dim} regions=${regions.length} out=${opts.out}`);
  console.log(`  assets=${opts.assetDirs.join(', ')}`);
  console.log(`  biome colors=${biomeColors ? 'enabled' : 'fallback'}`);
  const manifest = await readManifest(opts.out, opts.world);
  const previousHeightmap = manifest.dimensions[opts.dim]?.heightmap;
  const force = previousHeightmap?.format !== 'msgpack'
    || previousHeightmap.tileSizeBlocks !== TILE_BLOCKS
    || previousHeightmap.sampleStride !== opts.sampleStride
    || previousHeightmap.colorStride !== opts.colorStride
    || previousHeightmap.colorVersion !== HEIGHTMAP_COLOR_VERSION;
  const previousByKey = new Map<string, RegionManifestEntry>((force ? [] : previousHeightmap?.regions ?? [])
    .map((region) => [`${region.x},${region.z}`, region] as const));
  const previousSources = previousHeightmap?.sources ?? [];
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
  for (const previous of previousSources.length ? previousSources : previousHeightmap?.regions ?? []) {
    const key = `${previous.x},${previous.z}`;
    if (!force && currentKeys.has(key)) continue;
    await fs.rm(tileFile(opts.out, opts.dim, previous.x, previous.z), { force: true });
    removed++;
  }
  for (const [index, region] of regions.entries()) {
    const key = `${region.rx},${region.rz}`;
    const result = await bakeHeightmapRegion(
      region,
      opts,
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
    hasHeightmap: nextRegions.length > 0,
    heightmap: {
      tileSizeBlocks: TILE_BLOCKS,
      sampleStride: opts.sampleStride,
      colorStride: opts.colorStride,
      colorVersion: HEIGHTMAP_COLOR_VERSION,
      format: 'msgpack',
      regions: nextRegions,
      sources: nextSources,
    },
  });
  await writeManifest(opts.out, manifest);
  console.log(`wrote ${path.join(opts.out, 'manifest.json')} (${wrote} updated, ${skipped} unchanged, ${empty} empty, ${removed} removed)`);
}
