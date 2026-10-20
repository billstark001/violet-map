import type { Rgb } from '@violet-map/render';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadCapability } from '../capabilities.js';
import { bakeOptions, type BakeInput, type BakeOptions } from './bakeInput.js';

const { prepareTopMapRegion, topMapAction, topMapEnvironment, topMapParameters } = await loadCapability(
  '@violet-map/resources/top-map',
);
const { assetDirectoryDigest } = await loadCapability('@violet-map/resources/asset-digest');
const { createWorldSource } = await loadCapability('@violet-map/resources/world-chunks');
const { LocalStorage } = await loadCapability('@violet-map/storage/local');
const { artifactRef, verifyArtifact } = await loadCapability('@violet-map/storage');
const { generateTopMapTile } = await loadCapability('@violet-map/resources/top-map-bake');
const { ByteBudget } = await loadCapability('@violet-map/resources');
const { computeColumnLight } = await loadCapability('@violet-map/render');

const { sampleTopMapSurface } = await loadCapability('@violet-map/render/top-map/sample');

import { type BlockInfo } from '@violet-map/core/assets';
import { type BlockStateRef } from '@violet-map/core/domain';
import {
  TOP_MAP_SCHEMA,
  TOP_MAP_TILE_BLOCKS,
  type TopMapManifest,
  type TopMapRegionManifestEntry,
  type TopMapRegionSourceEntry,
  type TopMapTileSetManifest,
} from '@violet-map/core/formats/top-map';
import { dataFileCandidates, loadBlockInfo, readJsonFirst } from './assetInput.js';
import { infoGetter, loadBiomeColors, makeColorOf, makeTextureColorOf, stateColor } from './colorInput.js';
import { ensureLight } from './meshing.js';
import { ensureDir } from './paths.js';
import { type ColumnEntry, type RegionFile } from './worldInput.js';

const TOPMAP_COLOR_VERSION = 3;
const TOPMAP_LIGHT_VERSION = 1;

function dimOutDir(out: string, dim: string): string {
  return path.join(out, encodeURIComponent(dim), 'topmap');
}

function tileFile(out: string, dim: string, rx: number, rz: number): string {
  return path.join(dimOutDir(out, dim), `r.${rx}.${rz}.msgpack`);
}

async function readManifest(out: string, world: string): Promise<TopMapManifest> {
  const file = path.join(out, 'manifest.json');
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    return {
      schema: TOP_MAP_SCHEMA,
      generatedAt: new Date().toISOString(),
      world: path.basename(world),
      dimensions: {},
    };
  }
  let manifest: TopMapManifest;
  try {
    manifest = JSON.parse(text) as TopMapManifest;
  } catch (error) {
    throw new Error(`invalid top-map manifest: ${file}`, { cause: error });
  }
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    manifest.schema !== TOP_MAP_SCHEMA ||
    !manifest.dimensions ||
    typeof manifest.dimensions !== 'object' ||
    Array.isArray(manifest.dimensions)
  )
    throw new Error(`unsupported top-map manifest: ${file}`);
  if (manifest.world !== path.basename(world)) throw new Error(`top-map manifest belongs to another world: ${file}`);
  return manifest;
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

interface BakeRegionResult {
  entry: TopMapRegionManifestEntry | null;
  source: TopMapRegionSourceEntry;
  wrote: boolean;
  skipped: boolean;
  removed: boolean;
  empty: boolean;
}

function bakeColumnLight(entry: ColumnEntry, opts: BakeOptions, infoOf: (name: string) => BlockInfo) {
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
  previous: TopMapRegionManifestEntry | undefined,
  previousSource: TopMapRegionSourceEntry | undefined,
  force: boolean,
  source: ReturnType<typeof createWorldSource>,
  environment: string,
): Promise<BakeRegionResult> {
  const prepared = await prepareTopMapRegion(source, path.basename(opts.world), opts.dim, region.rx, region.rz, true);
  const hash = topMapAction(prepared.digest, environment, topMapParameters(opts, opts.hasSkyLight));
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
      if (stat.isFile() && stat.size > 0 && previous.artifact) {
        verifyArtifact(previous.artifact, new Uint8Array(await fs.readFile(outFile)));
        return {
          entry: previous,
          source: previousSource,
          wrote: false,
          skipped: true,
          removed: false,
          empty: false,
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const entries = prepared.entries;
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
  const output = generateTopMapTile(entries, region, opts, infoOf, colorOf, {
    light: (entry) => bakeColumnLight(entry, opts, infoOf),
    sample: sampleTopMapSurface,
    missingColor: stateColor,
  });
  if (!output) {
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
  const outDir = dimOutDir(opts.out, opts.dim);
  await ensureDir(outDir);
  await fs.writeFile(outFile, output);
  return {
    entry: {
      x: region.rx,
      z: region.rz,
      hash,
      artifact: artifactRef(output, 'application/msgpack', 'topmap-msgpack-v6'),
    },
    source: { x: region.rx, z: region.rz, hash, empty: false },
    wrote: true,
    skipped: false,
    removed: false,
    empty: false,
  };
}

export async function runBakeTopMap(input: BakeInput) {
  const opts = bakeOptions(input);
  const blockInfo = await loadBlockInfo(opts.blockInfo);
  const infoOf = infoGetter(blockInfo);
  const biomeColors = await loadBiomeColors(opts.assetDirs, opts.biomes);
  const colorOf =
    (await makeTextureColorOf(opts.assetDirs, infoOf, biomeColors)) ?? (blockInfo ? makeColorOf(infoOf) : null);
  const source = createWorldSource(new LocalStorage(path.dirname(opts.world)), {
    entities: false,
    cache: { regionBytes: 32 * 1024 ** 2, chunkNbtBytes: 0, worldListMs: 0 },
  });
  const coverage = await source.listChunkSourceCoverage(path.basename(opts.world), opts.dim);
  const coords = new Map<string, { rx: number; rz: number; file: string }>();
  for (const r of coverage.regions) coords.set(`${r.x},${r.z}`, { rx: r.x, rz: r.z, file: '' });
  for (const c of coverage.chunks) {
    const rx = Math.floor(c.cx / 32),
      rz = Math.floor(c.cz / 32);
    coords.set(`${rx},${rz}`, { rx, rz, file: '' });
  }
  const regions = [...coords.values()].sort((a, b) => a.rx - b.rx || a.rz - b.rz).slice(0, opts.limit);
  const rawBiomes = await readJsonFirst(dataFileCandidates('biomes.json', opts.biomes));
  const environment = topMapEnvironment(await assetDirectoryDigest(opts.assetDirs), blockInfo, rawBiomes);
  console.log(`bake-topmap world=${opts.world} dim=${opts.dim} regions=${regions.length} out=${opts.out}`);
  console.log(`  approach=${opts.approach} light=${opts.lightMode}${opts.hasSkyLight ? '' : ' no-sky'}`);
  console.log(`  assets=${opts.assetDirs.join(', ')}`);
  console.log(`  biome colors=${biomeColors ? 'enabled' : 'fallback'}`);
  const manifest = await readManifest(opts.out, opts.world);
  const previousTopMap = manifest.dimensions[opts.dim]?.topMap;
  const force =
    previousTopMap?.dependency?.environment !== environment ||
    previousTopMap?.dependency?.hasSkyLight !== opts.hasSkyLight ||
    previousTopMap?.format !== 'msgpack' ||
    previousTopMap.tileSizeBlocks !== TOP_MAP_TILE_BLOCKS ||
    previousTopMap.sampleStride !== opts.sampleStride ||
    previousTopMap.colorStride !== opts.colorStride ||
    previousTopMap.lightStride !== opts.lightStride ||
    previousTopMap.colorVersion !== TOPMAP_COLOR_VERSION ||
    previousTopMap.lightVersion !== TOPMAP_LIGHT_VERSION ||
    previousTopMap.approach !== opts.approach ||
    previousTopMap.lightMode !== opts.lightMode;
  const previousByKey = new Map<string, TopMapRegionManifestEntry>(
    (force ? [] : (previousTopMap?.regions ?? [])).map((region) => [`${region.x},${region.z}`, region] as const),
  );
  const previousSources = previousTopMap?.sources ?? [];
  const previousSourceByKey = new Map<string, TopMapRegionSourceEntry>(
    (force ? [] : previousSources).map((region) => [`${region.x},${region.z}`, region] as const),
  );
  const currentKeys = new Set<string>(regions.map((region) => `${region.rx},${region.rz}`));
  const nextRegions: TopMapRegionManifestEntry[] = [];
  const nextSources: TopMapRegionSourceEntry[] = [];
  let wrote = 0;
  let skipped = 0;
  let empty = 0;
  let removed = 0;

  await ensureDir(dimOutDir(opts.out, opts.dim));
  for (const previous of previousSources.length ? previousSources : (previousTopMap?.regions ?? [])) {
    const key = `${previous.x},${previous.z}`;
    if (!force && currentKeys.has(key)) continue;
    await fs.rm(tileFile(opts.out, opts.dim, previous.x, previous.z), { force: true });
    removed++;
  }
  const working = new ByteBudget(128 * 1024 ** 2);
  for (const [index, region] of regions.entries()) {
    const release = working.reserve(working.capacity);
    try {
      const key = `${region.rx},${region.rz}`;
      const result = await bakeTopMapRegion(
        region,
        opts,
        infoOf,
        colorOf,
        previousByKey.get(key),
        previousSourceByKey.get(key),
        force,
        source,
        environment,
      );
      if (result.entry) nextRegions.push(result.entry);
      nextSources.push(result.source);
      if (result.wrote) wrote++;
      if (result.skipped) skipped++;
      if (result.empty) empty++;
      if (result.removed) removed++;
      const action = result.skipped ? 'skip' : result.empty ? 'empty' : result.wrote ? 'write' : 'drop';
      console.log(`  ${index + 1}/${regions.length} ${action} r.${region.rx}.${region.rz}`);
    } finally {
      release();
    }
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
      dependency: { schemaVersion: 1, environment, hasSkyLight: opts.hasSkyLight },
      regions: nextRegions,
      sources: nextSources,
    } satisfies TopMapTileSetManifest,
  });
  await writeManifest(opts.out, manifest);
  console.log(
    `wrote ${path.join(opts.out, 'manifest.json')} (${wrote} updated, ${skipped} unchanged, ${empty} empty, ${removed} removed)`,
  );
}
