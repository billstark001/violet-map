import { LocalStorage } from '@violet-map/storage/local';
import type { AtomicObjectStorage } from '@violet-map/core/storage';
import type { ServerConfig } from './configuration.js';
import type { AssetService } from './assets.js';
import { defaultDataUrl } from '@violet-map/core/defaults';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import minecraftData from 'minecraft-data';
import { type BiomeMap, type DimensionMap } from '@violet-map/core/domain';
import {
  applyBlockInfoOverrides,
  createBlockInfoMap,
  type BlockInfo,
  type BlockInfoMap,
} from '@violet-map/core/assets';

export function createGameDataService(config: ServerConfig, assets: AssetService, overrides?: AtomicObjectStorage) {
  const { buildAssetBundle } = assets;
  const writableData: AtomicObjectStorage = overrides ?? new LocalStorage(config.data.dir);

  const defaultsDir = path.dirname(fileURLToPath(defaultDataUrl('biomes.json')));
  const dataFileCache = new Map<string, unknown>();
  const dataFileInflight = new Map<string, Promise<unknown>>();
  let dataGeneration = 0;

  function isMissingFile(error: unknown): boolean {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
  }

  async function readDataFile<T>(name: string): Promise<T> {
    if (dataFileCache.has(name)) return dataFileCache.get(name) as T;
    const pending = dataFileInflight.get(name);
    if (pending) return pending as Promise<T>;
    const generation = dataGeneration;
    const load = (async () => {
      if (overrides) {
        for (const key of [`versions/${config.minecraft.version}/${name}`, name]) {
          const bytes = await overrides.read(key);
          if (bytes) {
            const value = JSON.parse(new TextDecoder().decode(bytes)) as T;
            if (generation === dataGeneration) dataFileCache.set(name, value);
            return value;
          }
        }
      }
      const candidates = [
        path.join(config.data.dir, 'versions', config.minecraft.version, name),
        path.join(config.data.dir, name),
        path.join(defaultsDir, 'versions', config.minecraft.version, name),
        path.join(defaultsDir, name),
      ];
      for (const file of candidates) {
        let text: string;
        try {
          text = await fs.readFile(file, 'utf8');
        } catch (error) {
          if (isMissingFile(error)) continue;
          throw error;
        }
        let value: T;
        try {
          value = JSON.parse(text) as T;
        } catch (error) {
          throw new Error(`invalid JSON in ${file}`, { cause: error });
        }
        if (generation === dataGeneration) dataFileCache.set(name, value);
        return value;
      }
      throw new Error(`missing data file: ${name}`);
    })();
    dataFileInflight.set(name, load);
    try {
      return await load;
    } finally {
      if (dataFileInflight.get(name) === load) dataFileInflight.delete(name);
    }
  }
  /** Atomically publish a root data file, then invalidate earlier readers.
   * Undefined/non-JSON values fail before storage changes; local files keep their
   * readable indentation and mounted object overrides retain compact encoding. */
  async function writeDataFile(name: string, value: unknown): Promise<void> {
    const json = JSON.stringify(value, null, overrides ? undefined : 2);
    if (json === undefined) throw new TypeError('data file must contain a JSON value');
    await writableData.replace(name, new TextEncoder().encode(json), 'application/json');
    dataGeneration++;
    dataFileCache.delete(name);
    dataFileInflight.delete(name);
  }

  const readBiomes = () => readDataFile<BiomeMap>('biomes.json');
  const readDimensions = () => readDataFile<DimensionMap>('dimensions.json');

  let blockInfoCache: BlockInfoMap | null = null;
  let blockInfoPromise: Promise<BlockInfoMap> | null = null;

  function clearGameDataCaches(): void {
    dataGeneration++;
    dataFileCache.clear();
    dataFileInflight.clear();
    blockInfoCache = null;
    blockInfoPromise = null;
  }

  function latestSupportedMcDataVersion(): string {
    const versions = (minecraftData as any).supportedVersions?.pc as string[] | undefined;
    return versions?.[versions.length - 1] ?? '1.21.11';
  }

  function loadMinecraftData(version = config.minecraft.dataVersion) {
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
  async function buildBlockInfo(): Promise<BlockInfoMap> {
    if (blockInfoCache) return blockInfoCache;
    if (blockInfoPromise) return blockInfoPromise;
    const generation = dataGeneration;
    const build = (async () => {
      let d = loadMinecraftData();
      try {
        const bundle = await buildAssetBundle();
        const latest = latestSupportedMcDataVersion();
        const latestData = loadMinecraftData(latest);
        if (
          Object.keys(bundle.blockstates).length > d.blocksArray.length &&
          latestData.blocksArray.length > d.blocksArray.length
        ) {
          console.warn(
            `[violet-map] assets look newer than minecraft-data ${d.version.minecraftVersion}; using ${latest}`,
          );
          d = latestData;
        }
      } catch {
        // Asset bundle is only used to pick a closer minecraft-data version.
      }
      const map = createBlockInfoMap(d.blocksArray);
      const overrides = await readDataFile<Record<string, Partial<BlockInfo>>>('block-overrides.json');
      applyBlockInfoOverrides(map, overrides);
      if (generation === dataGeneration) blockInfoCache = map;
      return map;
    })();
    blockInfoPromise = build;
    try {
      return await build;
    } finally {
      if (blockInfoPromise === build) blockInfoPromise = null;
    }
  }
  return { writeDataFile, readBiomes, readDimensions, clearGameDataCaches, buildBlockInfo };
}

export type GameDataService = ReturnType<typeof createGameDataService>;
