import {
  applyBlockInfoOverrides,
  createBlockInfoMap,
  type BlockInfo,
  type BlockInfoMap,
} from '@violet-map/core/assets';
import minecraftData from 'minecraft-data';

/** The selected Minecraft data version is explicit. Unsupported data is a configuration error. */
export function createGameDataSource(options: {
  dataVersion: string;
  readOverrides(): Promise<Record<string, Partial<BlockInfo>>>;
}) {
  let generation = 0;
  let pending: Promise<BlockInfoMap> | undefined;
  return {
    clear() {
      generation++;
      pending = undefined;
    },
    async buildBlockInfo(): Promise<BlockInfoMap> {
      if (pending) return pending;
      const current = generation;
      const build = (async () => {
        const data = minecraftData(options.dataVersion);
        if (!data) throw new Error(`unsupported minecraft-data version: ${options.dataVersion}`);
        const map = createBlockInfoMap(data.blocksArray);
        applyBlockInfoOverrides(map, await options.readOverrides());
        return map;
      })();
      pending = build;
      try {
        return await build;
      } finally {
        if (current === generation && pending === build) pending = undefined;
      }
    },
  };
}
