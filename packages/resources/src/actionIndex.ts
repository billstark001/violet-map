import type { ActionIndex } from './catalog.js';
import { MemoryActionIndex } from './catalog/memory.js';

export type ActionIndexConfig = { driver: 'memory' } | { driver: 'sqlite'; path: string };

/** Selection precedes loading; a selected driver failure is never converted to another driver. */
export async function createActionIndex(config: ActionIndexConfig, metadataBytes: number): Promise<ActionIndex> {
  if (config.driver === 'memory') return new MemoryActionIndex(metadataBytes);
  if (config.driver === 'sqlite') {
    const { SqliteActionIndex } = await import('./catalog/sqlite.js');
    return new SqliteActionIndex(config.path, metadataBytes);
  }
  throw new TypeError('unknown resource index driver');
}
