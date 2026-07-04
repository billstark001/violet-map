import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import minecraftData from 'minecraft-data';
import { BiomeMap, BlockInfo, BlockInfoMap, DimensionMap } from '@mcr/core';
import { config } from './config.js';

const defaultsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../data-defaults');

async function readDataFile<T>(name: string): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(path.join(config.dataDir, name), 'utf8')) as T;
  } catch {
    return JSON.parse(await fs.readFile(path.join(defaultsDir, name), 'utf8')) as T;
  }
}
export async function writeDataFile(name: string, value: unknown): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(path.join(config.dataDir, name), JSON.stringify(value, null, 2));
}

export const readBiomes = () => readDataFile<BiomeMap>('biomes.json');
export const readDimensions = () => readDataFile<DimensionMap>('dimensions.json');

let blockInfoCache: BlockInfoMap | null = null;

/** 用 minecraft-data 生成方块物理/渲染属性，再套用可编辑的覆盖文件（支持 * 通配）。 */
export async function buildBlockInfo(): Promise<BlockInfoMap> {
  if (blockInfoCache) return blockInfoCache;
  const d = minecraftData(config.mcVersion);
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