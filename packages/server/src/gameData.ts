import { type BlockInfo } from '@violet-map/core/assets';
import { defaultDataUrl } from '@violet-map/core/defaults';
import { type BiomeMap, type DimensionMap } from '@violet-map/core/domain';
import type { AtomicObjectStorage } from '@violet-map/core/storage';
import { canonicalJson, ResourceError } from '@violet-map/core/resources';
import { sha256 } from '@violet-map/storage';
import { createGameDataSource } from '@violet-map/resources/game-data';
import { LocalStorage } from '@violet-map/storage/local';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerConfig } from './configuration.js';

export function createGameDataService(config: ServerConfig, overrides?: AtomicObjectStorage) {
  const writableData: AtomicObjectStorage = overrides ?? new LocalStorage(config.data.dir);

  const defaultsDir = path.dirname(fileURLToPath(defaultDataUrl('biomes.json')));
  const dataFileInflight = new Map<string, Promise<unknown>>();
  const maxBytes = 8 * 1024 ** 2;

  async function selectInput(name: string) {
    const files = [
      path.join(config.data.dir, 'versions', config.minecraft.version, name),
      path.join(config.data.dir, name),
      path.join(defaultsDir, 'versions', config.minecraft.version, name),
      path.join(defaultsDir, name),
    ];
    const candidates = [
      ...(overrides
        ? [`versions/${config.minecraft.version}/${name}`, name].map((key) => ({ reader: overrides, key, label: key }))
        : []),
      ...files.map((file) => ({ reader: new LocalStorage(path.dirname(file)), key: path.basename(file), label: file })),
    ];
    for (const candidate of candidates) {
      const before = await candidate.reader.stat(candidate.key);
      if (!before) continue;
      if (before.size > maxBytes)
        throw new ResourceError('RESOURCE_BUSY', `game data exceeds input budget: ${candidate.label}`);
      return {
        label: candidate.label,
        revision:
          before.etag && !/^W\//i.test(before.etag)
            ? canonicalJson([candidate.label, before.size, before.etag])
            : undefined,
        async read() {
          const bytes = await candidate.reader.readRange(candidate.key, 0, before.size + 1);
          const after = await candidate.reader.stat(candidate.key);
          if (
            !bytes ||
            bytes.length !== before.size ||
            !after ||
            after.size !== before.size ||
            after.etag !== before.etag ||
            after.modifiedAt !== before.modifiedAt
          )
            throw new ResourceError(
              'SOURCE_SNAPSHOT_CHANGED',
              `game data changed during read: ${candidate.label}`,
              true,
            );
          return bytes;
        },
      };
    }
    throw new Error(`missing data file: ${name}`);
  }

  async function readDataFile<T>(name: string): Promise<T> {
    const pending = dataFileInflight.get(name);
    if (pending) return pending as Promise<T>;

    const load = (async () => {
      const input = await selectInput(name);
      const bytes = await input.read();
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T;
      } catch (error) {
        throw new Error(`invalid JSON in ${input.label}`, { cause: error });
      }
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
    const bytes = new TextEncoder().encode(json);
    if (bytes.length > maxBytes) throw new ResourceError('RESOURCE_BUSY', 'game data exceeds input budget');
    await writableData.replace(name, bytes, 'application/json');
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
  async function revision() {
    const inputs = [];
    for (const name of ['block-overrides.json', 'biomes.json', 'dimensions.json']) {
      const input = await selectInput(name);
      inputs.push(input.revision ?? canonicalJson([input.label, sha256(await input.read())]));
    }
    return sha256(canonicalJson([config.minecraft.dataVersion, inputs]));
  }
  return { writeDataFile, readBiomes, readDimensions, clearGameDataCaches, buildBlockInfo, revision };
}

export type GameDataService = ReturnType<typeof createGameDataService>;
