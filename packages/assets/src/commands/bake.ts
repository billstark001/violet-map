import fs from 'node:fs/promises';
import path from 'node:path';
import {
  AIR_NAMES,
  meshLodChunk,
  type BlockInfoMap,
  type BlockStateRef,
  type MeshBuffers,
} from '@violet-map/core';
import {
  argsReader,
  defaultTopMapOut,
  encodeTypedArray,
  ensureDir,
  ensureLight,
  findRegionFiles,
  infoGetter,
  loadBlockInfo,
  loadRegionColumns,
  makeColorOf,
  makeNeighborhood,
  numberArg,
  parseDim,
  resolvePath,
  stateColor,
  type ColumnEntry,
  type RegionFile,
} from './common.js';

interface TileSetManifest {
  tileSizeBlocks: number;
  regions: { x: number; z: number }[];
}

interface DimensionManifest {
  hasTopMap: boolean;
  hasLod8: boolean;
  hasHeightmap: boolean;
  lod8?: TileSetManifest;
  heightmap?: TileSetManifest;
}

interface TopMapManifest {
  schema: 1;
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
  step: number;
}

const TILE_BLOCKS = 512;

function usage(kind: 'lod' | 'heightmap'): string {
  const command = kind === 'lod' ? 'bake-lod' : 'bake-heightmap';
  return `Usage:
  vm-assets ${command} <world> [--dim <id>] [--out <dir>] [--limit <regions>] [--block-info <file>] [--no-sky]${kind === 'lod' ? ' [--step <n>]' : ''}`;
}

function parseOptions(args: string[], kind: 'lod' | 'heightmap'): BakeOptions {
  const reader = argsReader(args);
  const world = args.find((arg) => !arg.startsWith('-'));
  if (!world) throw new Error(`missing world path\n${usage(kind)}`);
  const resolvedWorld = resolvePath(world);
  return {
    world: resolvedWorld,
    dim: parseDim(reader.get('--dim', 'minecraft:overworld')),
    out: resolvePath(reader.get('--out') ?? defaultTopMapOut(resolvedWorld)),
    limit: Math.floor(numberArg(reader.get('--limit'), Infinity, 1)),
    hasSkyLight: !reader.flag('--no-sky'),
    blockInfo: reader.get('--block-info'),
    step: Math.floor(numberArg(reader.get('--step'), 8, 1)),
  };
}

function dimOutDir(out: string, dim: string, kind: 'lod8' | 'heightmap'): string {
  return path.join(out, encodeURIComponent(dim), kind);
}

async function readManifest(out: string, world: string): Promise<TopMapManifest> {
  const file = path.join(out, 'manifest.json');
  try {
    const manifest = JSON.parse(await fs.readFile(file, 'utf8')) as TopMapManifest;
    if (manifest.schema === 1 && manifest.dimensions && typeof manifest.dimensions === 'object') return manifest;
  } catch {
    // Create a fresh manifest below.
  }
  return {
    schema: 1,
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
  const previous = manifest.dimensions[dim] ?? { hasTopMap: false, hasLod8: false, hasHeightmap: false };
  const next = { ...previous, ...patch };
  next.hasTopMap = next.hasLod8 || next.hasHeightmap;
  manifest.dimensions[dim] = next;
}

function topBlock(col: { minY: number; heightAt(x: number, z: number): number; getBlock(x: number, y: number, z: number): BlockStateRef }, x: number, z: number): { y: number; state: BlockStateRef | null } {
  for (let y = col.heightAt(x, z) - 1; y >= col.minY; y--) {
    const state = col.getBlock(x, y, z);
    if (!AIR_NAMES.has(state.name)) return { y, state };
  }
  return { y: col.minY, state: null };
}

function writeRgba(colors: Uint8Array, index: number, state: BlockStateRef | null) {
  const offset = index * 4;
  if (!state) {
    colors[offset] = 0;
    colors[offset + 1] = 0;
    colors[offset + 2] = 0;
    colors[offset + 3] = 0;
    return;
  }
  const color = stateColor(state);
  colors[offset] = Math.round(color[0] * 255);
  colors[offset + 1] = Math.round(color[1] * 255);
  colors[offset + 2] = Math.round(color[2] * 255);
  colors[offset + 3] = 255;
}

function meshPayload(mesh: MeshBuffers) {
  return {
    positions: encodeTypedArray(mesh.positions),
    positionType: 'uint16',
    colors: encodeTypedArray(mesh.colors),
    colorType: 'uint8',
    lights: encodeTypedArray(mesh.lights),
    lightType: 'uint8',
    indices: encodeTypedArray(mesh.indices),
    indexType: mesh.indices instanceof Uint32Array ? 'uint32' : 'uint16',
    bounds: mesh.bounds,
  };
}

async function bakeHeightmapRegion(region: RegionFile, opts: BakeOptions) {
  const entries = await loadRegionColumns(region.file);
  const heights = new Int16Array(TILE_BLOCKS * TILE_BLOCKS);
  const colors = new Uint8Array(TILE_BLOCKS * TILE_BLOCKS * 4);
  heights.fill(-32768);
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
        const i = tileZ * TILE_BLOCKS + tileX;
        heights[i] = top.y;
        writeRgba(colors, i, top.state);
        minY = Math.min(minY, top.y);
        maxY = Math.max(maxY, top.y);
      }
    }
  }

  const payload = {
    schema: 1,
    kind: 'heightmap',
    dimension: opts.dim,
    region: { x: region.rx, z: region.rz },
    origin: { x: region.rx * TILE_BLOCKS, z: region.rz * TILE_BLOCKS },
    size: { blocks: TILE_BLOCKS },
    chunks,
    minY: Number.isFinite(minY) ? minY : 0,
    maxY: Number.isFinite(maxY) ? maxY : 0,
    heightEncoding: 'int16le-base64',
    colorEncoding: 'rgba8888-base64',
    heights: encodeTypedArray(heights),
    colors: encodeTypedArray(colors),
  };

  const outDir = dimOutDir(opts.out, opts.dim, 'heightmap');
  await ensureDir(outDir);
  await fs.writeFile(path.join(outDir, `r.${region.rx}.${region.rz}.json`), `${JSON.stringify(payload)}\n`);
}

async function bakeLodRegion(region: RegionFile, opts: BakeOptions, blockInfo: BlockInfoMap | undefined) {
  const entries = await loadRegionColumns(region.file);
  const infoOf = infoGetter(blockInfo);
  const colorOf = makeColorOf(infoOf);
  for (const entry of entries.values()) ensureLight(entry, infoOf, opts.hasSkyLight);
  const chunks = [];
  for (const entry of entries.values()) {
    const hood = makeNeighborhood(entries, entry.col);
    const mesh = meshLodChunk(entry.col, opts.step, colorOf, opts.hasSkyLight, hood, infoOf);
    if (!mesh) continue;
    chunks.push({
      cx: entry.col.x,
      cz: entry.col.z,
      step: opts.step,
      mesh: meshPayload(mesh),
    });
  }
  const payload = {
    schema: 1,
    kind: 'lod8',
    dimension: opts.dim,
    region: { x: region.rx, z: region.rz },
    origin: { x: region.rx * TILE_BLOCKS, z: region.rz * TILE_BLOCKS },
    chunks,
  };
  const outDir = dimOutDir(opts.out, opts.dim, 'lod8');
  await ensureDir(outDir);
  await fs.writeFile(path.join(outDir, `r.${region.rx}.${region.rz}.json`), `${JSON.stringify(payload)}\n`);
}

async function selectRegions(opts: BakeOptions): Promise<RegionFile[]> {
  const regions = await findRegionFiles(opts.world, opts.dim);
  return Number.isFinite(opts.limit) ? regions.slice(0, opts.limit) : regions;
}

export async function runBakeHeightmap(args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage('heightmap'));
    return;
  }
  const opts = parseOptions(args, 'heightmap');
  const regions = await selectRegions(opts);
  console.log(`bake-heightmap world=${opts.world} dim=${opts.dim} regions=${regions.length} out=${opts.out}`);
  for (const [index, region] of regions.entries()) {
    await bakeHeightmapRegion(region, opts);
    console.log(`  ${index + 1}/${regions.length} r.${region.rx}.${region.rz}`);
  }
  const manifest = await readManifest(opts.out, opts.world);
  updateDimensionManifest(manifest, opts.dim, {
    hasHeightmap: true,
    heightmap: { tileSizeBlocks: TILE_BLOCKS, regions: regions.map((r) => ({ x: r.rx, z: r.rz })) },
  });
  await writeManifest(opts.out, manifest);
  console.log(`wrote ${path.join(opts.out, 'manifest.json')}`);
}

export async function runBakeLod(args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage('lod'));
    return;
  }
  const opts = parseOptions(args, 'lod');
  const blockInfo = await loadBlockInfo(opts.blockInfo);
  const regions = await selectRegions(opts);
  console.log(`bake-lod world=${opts.world} dim=${opts.dim} step=${opts.step} regions=${regions.length} out=${opts.out}`);
  for (const [index, region] of regions.entries()) {
    await bakeLodRegion(region, opts, blockInfo);
    console.log(`  ${index + 1}/${regions.length} r.${region.rx}.${region.rz}`);
  }
  const manifest = await readManifest(opts.out, opts.world);
  updateDimensionManifest(manifest, opts.dim, {
    hasLod8: opts.step === 8 || manifest.dimensions[opts.dim]?.hasLod8 === true,
    lod8: { tileSizeBlocks: TILE_BLOCKS, regions: regions.map((r) => ({ x: r.rx, z: r.rz })) },
  });
  await writeManifest(opts.out, manifest);
  console.log(`wrote ${path.join(opts.out, 'manifest.json')}`);
}
