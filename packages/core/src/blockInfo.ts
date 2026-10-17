import type { BlockInfo, BlockInfoMap } from './assets.js';

export interface BlockDefinition {
  /** Unqualified Minecraft registry name, as supplied by minecraft-data. */
  name: string;
  transparent?: boolean;
  boundingBox?: string;
  emitLight?: number;
  filterLight?: number;
}

const REGEXP_META = /[.+?^${}()|[\]\\]/g;
const DEFAULT_OVERRIDE_INFO: BlockInfo = { occludes: false, emit: 0, filter: 0, layer: 'cutout', tint: 'none' };

/** Convert registry definitions without depending on a particular Minecraft-data
 * provider. Each entry owns its mutable metadata object. */
export function createBlockInfoMap(blocks: readonly BlockDefinition[]): BlockInfoMap {
  const map: BlockInfoMap = {};
  for (const block of blocks) {
    const transparent = block.transparent === true;
    map[`minecraft:${block.name}`] = {
      occludes: !transparent && block.boundingBox === 'block',
      emit: block.emitLight ?? 0,
      filter: block.filterLight ?? (transparent ? 0 : 15),
      layer: transparent ? 'cutout' : 'opaque',
      tint: 'none',
    };
  }
  return map;
}

/** Apply ordered exact/glob patches in place. `*` is the only wildcard; new exact
 * IDs receive nonoccluding defaults. Later patches win for overlapping fields. */
export function applyBlockInfoOverrides(map: BlockInfoMap, overrides: Record<string, Partial<BlockInfo>>): void {
  for (const [pattern, patch] of Object.entries(overrides)) {
    if (pattern.includes('*')) {
      const expression = new RegExp(`^${pattern.replace(REGEXP_META, '\\$&').replace(/\*/g, '.*')}$`);
      for (const key of Object.keys(map)) if (expression.test(key)) Object.assign(map[key], patch);
    } else {
      // Treat dictionary keys as data even for names such as __proto__.
      const previous = Object.hasOwn(map, pattern) ? map[pattern] : DEFAULT_OVERRIDE_INFO;
      Object.defineProperty(map, pattern, {
        value: { ...previous, ...patch },
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
}
