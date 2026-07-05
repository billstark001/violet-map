import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getRegionChunk } from '@violet-map/core/region';
import { parseNbt, decompress } from '@violet-map/core/nbt';
import { config } from './config.js';

const VANILLA_DIMS: Record<string, string[]> = {
  'minecraft:overworld': ['region', 'dimensions/minecraft/overworld/region'],
  'minecraft:the_nether': ['DIM-1/region', 'dimensions/minecraft/the_nether/region'],
  'minecraft:the_end': ['DIM1/region', 'dimensions/minecraft/the_end/region'],
};
const WORLD_RE = /^[A-Za-z0-9_.-]+$/;

function assertWorldName(world: string) {
  if (!WORLD_RE.test(world)) throw new Error('invalid world name');
}
const dimDirName = (dim: string) => encodeURIComponent(dim);

function regionDir(world: string, dim: string): string {
  assertWorldName(world);
  const base = path.join(config.worldsDir, world);
  const candidates = VANILLA_DIMS[dim] ?? [path.join('dimensions', ...dim.split(':'), 'region')];
  for (const sub of candidates) {
    const dir = path.join(base, sub);
    if (existsSync(dir)) return dir;
  }
  return path.join(base, candidates[0]);
}
function chunkOverrideDir(world: string, dim: string): string {
  assertWorldName(world);
  return path.join(config.worldsDir, world, 'chunks', dimDirName(dim));
}

export async function listWorlds(): Promise<{ id: string; dimensions: string[] }[]> {
  let entries;
  try { entries = await fs.readdir(config.worldsDir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dims: string[] = [];
    for (const dim of Object.keys(VANILLA_DIMS)) {
      try {
        const files = await fs.readdir(regionDir(e.name, dim));
        if (files.some((f) => f.endsWith('.mca'))) dims.push(dim);
      } catch { /* absent */ }
    }
    try {
      const chunkDims = await fs.readdir(path.join(config.worldsDir, e.name, 'chunks'));
      for (const cd of chunkDims) {
        const dim = decodeURIComponent(cd);
        if (!dims.includes(dim)) dims.push(dim);
      }
    } catch { /* absent */ }
    if (dims.length) out.push({ id: e.name, dimensions: dims });
  }
  return out;
}

export async function listRegions(world: string, dim: string): Promise<{ x: number; z: number }[]> {
  try {
    const files = await fs.readdir(regionDir(world, dim));
    return files
      .map((f) => /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(f))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ x: Number(m[1]), z: Number(m[2]) }));
  } catch { return []; }
}

// 区域文件 LRU
const regionCache = new Map<string, Uint8Array>();
const chunkNbtCache = new Map<string, Uint8Array>();
const MAX_REGION_CACHE = 16;
const MAX_CHUNK_NBT_CACHE = 512;

function chunkCacheKey(world: string, dim: string, cx: number, cz: number): string {
  return `${world}|${dim}|${cx},${cz}`;
}

function rememberChunk(key: string, data: Uint8Array): Uint8Array {
  chunkNbtCache.set(key, data);
  if (chunkNbtCache.size > MAX_CHUNK_NBT_CACHE) chunkNbtCache.delete(chunkNbtCache.keys().next().value!);
  return data;
}

function clearChunkCacheFor(world: string, dim: string) {
  const prefix = `${world}|${dim}|`;
  for (const key of chunkNbtCache.keys()) {
    if (key.startsWith(prefix)) chunkNbtCache.delete(key);
  }
}

async function readRegionFile(file: string): Promise<Uint8Array | null> {
  const hit = regionCache.get(file);
  if (hit) { regionCache.delete(file); regionCache.set(file, hit); return hit; }
  try {
    const buf = new Uint8Array(await fs.readFile(file));
    regionCache.set(file, buf);
    if (regionCache.size > MAX_REGION_CACHE) regionCache.delete(regionCache.keys().next().value!);
    return buf;
  } catch { return null; }
}

/** 取一个区块的未压缩 NBT。优先单区块上传覆盖，其次 region 文件。 */
export async function getChunkNbt(world: string, dim: string, cx: number, cz: number): Promise<Uint8Array | null> {
  const cacheKey = chunkCacheKey(world, dim, cx, cz);
  const hit = chunkNbtCache.get(cacheKey);
  if (hit) { chunkNbtCache.delete(cacheKey); chunkNbtCache.set(cacheKey, hit); return hit; }
  try {
    const file = path.join(chunkOverrideDir(world, dim), `c.${cx}.${cz}.nbt`);
    return rememberChunk(cacheKey, decompress(new Uint8Array(await fs.readFile(file))));
  } catch { /* fall through */ }
  const region = await readRegionFile(path.join(regionDir(world, dim), `r.${cx >> 5}.${cz >> 5}.mca`));
  if (!region) return null;
  const data = getRegionChunk(region, cx & 31, cz & 31);
  return data ? rememberChunk(cacheKey, data) : null;
}

export async function saveRegionFile(world: string, dim: string, name: string, bytes: Uint8Array): Promise<void> {
  if (!/^r\.-?\d+\.-?\d+\.mca$/.test(name)) throw new Error('invalid region file name');
  const dir = regionDir(world, dim);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), bytes);
  regionCache.delete(path.join(dir, name));
  clearChunkCacheFor(world, dim);
}

export async function saveChunkNbt(world: string, dim: string, bytes: Uint8Array): Promise<{ x: number; z: number }> {
  const root = parseNbt(bytes);
  const r = root.Level ?? root;
  const x = r.xPos, z = r.zPos;
  if (typeof x !== 'number' || typeof z !== 'number') throw new Error('chunk NBT missing xPos/zPos');
  const dir = chunkOverrideDir(world, dim);
  const data = decompress(bytes);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `c.${x}.${z}.nbt`), data);
  rememberChunk(chunkCacheKey(world, dim, x, z), data);
  return { x, z };
}
