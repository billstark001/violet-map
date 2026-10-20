import { type BlockInfo } from '@violet-map/core/assets';
import { defaultDataUrl } from '@violet-map/core/defaults';
import { type BiomeMap, type DimensionMap } from '@violet-map/core/domain';
import type { AtomicObjectStorage } from '@violet-map/core/storage';
import { createGameDataSource } from '@violet-map/resources/game-data';
import { LocalStorage } from '@violet-map/storage/local';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerConfig } from './configuration.js';

export function createGameDataService(config: ServerConfig, overrides?: AtomicObjectStorage) {
  const writableData: AtomicObjectStorage = overrides ?? new LocalStorage(config.data.dir);

  const defaultsDir = path.dirname(fileURLToPath(defaultDataUrl('biomes.json')));
  const dataFileInflight = new Map<string, Promise<unknown>>();

  function isMissingFile(error: unknown): boolean {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
  }

  async function readDataFile<T>(name: string): Promise<T> {
    const pending = dataFileInflight.get(name);
    if (pending) return pending as Promise<T>;

    const load = (async () => {
      if (overrides) {
        for (const key of [`versions/${config.minecraft.version}/${name}`, name]) {
          const bytes = await overrides.read(key);
          if (bytes) {
            const value = JSON.parse(new TextDecoder().decode(bytes)) as T;
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
    clearBlockInfo();
    dataFileInflight.delete(name);
  }

  const readBiomes = () => readDataFile<BiomeMap>('biomes.json');
  const readDimensions = () => readDataFile<DimensionMap>('dimensions.json');

  function clearGameDataCaches(): void {
    dataFileInflight.clear();
    clearBlockInfo();
  }

  const { buildBlockInfo, clear: clearBlockInfo } = createGameDataSource({
    dataVersion: config.minecraft.dataVersion,
    readOverrides: () => readDataFile<Record<string, Partial<BlockInfo>>>('block-overrides.json'),
  });
  return { writeDataFile, readBiomes, readDimensions, clearGameDataCaches, buildBlockInfo };
}

export type GameDataService = ReturnType<typeof createGameDataService>;
