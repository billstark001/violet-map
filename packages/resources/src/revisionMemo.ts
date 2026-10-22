import { LruCache } from '@violet-map/core/cache';
import { ResourceError } from '@violet-map/core/resources';
import { Singleflight } from './singleflight.js';

/** Bounded dependency metadata, never artifact bytes. Weak revisions bypass
 * retention; a portable digest is still produced by the content loader. */
export class RevisionMemo {
  private readonly cache: LruCache<string, { revision: string; value: string; weight: number }>;
  private readonly pending = new Singleflight(16);
  private active = 0;
  constructor(bytes: number) {
    this.cache = new LruCache({ maxEntries: 1024, maxWeight: bytes, weightOf: (entry) => entry.weight });
  }
  async get(key: string, revision: () => Promise<string | undefined>, load: () => Promise<string>): Promise<string> {
    if (this.active >= 16 || key.length > 4096)
      throw new ResourceError('RESOURCE_BUSY', 'dependency validation limit exhausted', true);
    this.active++;
    try {
      const before = await revision();
      const hit = this.cache.get(key);
      if (before !== undefined && hit?.revision === before) return hit.value;
      return await this.pending.run(key + ':' + (before ?? 'weak'), async () => {
        const value = await load();
        if (before !== undefined) {
          if ((await revision()) !== before)
            throw new ResourceError('SOURCE_SNAPSHOT_CHANGED', 'dependency changed during validation', true);
          this.cache.set(key, {
            revision: before,
            value,
            weight: 512 + (key.length + before.length + value.length) * 2,
          });
        }
        return value;
      });
    } finally {
      this.active--;
    }
  }
}
