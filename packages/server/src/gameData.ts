import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import minecraftData from 'minecraft-data';
import { BiomeMap, BlockInfo, BlockInfoMap, DimensionMap } from '@violet-map/core';
import { config } from './config.js';
import { buildAssetBundle } from './assets.js';

const defaultsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../data-defaults');

async function readDataFile<T>(name: string): Promise<T> {
  const candidates = [
    path.join(config.dataDir, 'versions', config.mcVersion, name),
    path.join(config.dataDir, name),
    path.join(defaultsDir, 'versions', config.mcVersion, name),
    path.join(defaultsDir, name),
  ];
  for (const file of candidates) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as T;
    } catch { /* try next */ }
  }
  throw new Error(`missing data file: ${name}`);
}
export async function writeDataFile(name: string, value: unknown): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(path.join(config.dataDir, name), JSON.stringify(value, null, 2));
}

export const readBiomes = () => readDataFile<BiomeMap>('biomes.json');
export const readDimensions = () => readDataFile<DimensionMap>('dimensions.json');

let blockInfoCache: BlockInfoMap | null = null;

function latestSupportedMcDataVersion(): string {
  const versions = (minecraftData as any).supportedVersions?.pc as string[] | undefined;
  return versions?.[versions.length - 1] ?? '1.21.11';
}

function loadMinecraftData(version = config.mcDataVersion) {
  try {
    const data = minecraftData(version);
    if (!data) throw new Error(`minecraft-data returned no data for ${version}`);
    return data;
  } catch (e) {
    const fallback = latestSupportedMcDataVersion();
    if (version === fallback) throw e;
    console.warn(`[violet-map] minecraft-data does not support ${version}; falling back to ${fallback}`);
    const data = minecraftData(fallback);
    if (!data) throw e;
    return data;
  }
}

/** 用 minecraft-data 生成方块物理/渲染属性，再套用可编辑的覆盖文件（支持 * 通配）。 */
export async function buildBlockInfo(): Promise<BlockInfoMap> {
  if (blockInfoCache) return blockInfoCache;
  let d = loadMinecraftData();
  try {
    const bundle = await buildAssetBundle();
    const latest = latestSupportedMcDataVersion();
    const latestData = loadMinecraftData(latest);
    if (Object.keys(bundle.blockstates).length > d.blocksArray.length && latestData.blocksArray.length > d.blocksArray.length) {
      console.warn(`[violet-map] assets look newer than minecraft-data ${d.version.minecraftVersion}; using ${latest}`);
      d = latestData;
    }
  } catch {
    // Asset bundle is only used to pick a closer minecraft-data version.
  }
  const map: BlockInfoMap = {};
  for (const b of d.blocksArray) {
    const transparent = b.transparent === true;
    map[`minecraft:${b.name}`] = {
      occludes: !transparent && b.boundingBox === 'block',
      emit: b.emitLight ?? 0,
      filter: b.filterLight ?? (transparent ? 0 : 15),
      layer: transparent ? 'cutout' : 'opaque',
      tint: 'none',
    };
  }
  const overrides = await readDataFile<Record<string, Partial<BlockInfo>>>('block-overrides.json');
  for (const [pattern, patch] of Object.entries(overrides)) {
    if (pattern.includes('*')) {
      const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      for (const key of Object.keys(map)) if (re.test(key)) Object.assign(map[key], patch);
    } else {
      map[pattern] = { ...(map[pattern] ?? { occludes: false, emit: 0, filter: 0, layer: 'cutout', tint: 'none' }), ...patch };
    }
  }
  blockInfoCache = map;
  return map;
}
