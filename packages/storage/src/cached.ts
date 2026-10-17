import type { StoredFileInfo, ObjectStorage } from '@violet-map/core/storage';
import { LruCache } from '@violet-map/core/cache';
import { cleanStoragePath } from './paths.js';

export interface StorageCacheOptions {
  /** Cache metadata probes; defaults are intentionally short to tolerate external writers. */
  statTtlMs?: number;
  listTtlMs?: number;
  /** Maximum keys retained per metadata cache; defaults to 4096. */
  maxEntries?: number;
  /** Maximum total items retained in each list cache; defaults to 65536. */
  maxListItems?: number;
}

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

/**
 * Short-TTL metadata cache for a shared storage backend. It coalesces repeated
 * stat/list calls without caching world bytes. Writes clear every metadata entry
 * so normal server mutations are visible immediately.
 */
export class CachedStorage implements ObjectStorage {
  readonly kind: ObjectStorage['kind'];
  private readonly statTtlMs: number;
  private readonly listTtlMs: number;
  private readonly stats: LruCache<string, CacheEntry<StoredFileInfo | null>>;
  private readonly lists: LruCache<string, CacheEntry<StoredFileInfo[]>>;
  private readonly directories: LruCache<string, CacheEntry<string[]>>;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private generation = 0;

  constructor(
    private readonly storage: ObjectStorage,
    options: StorageCacheOptions = {},
  ) {
    this.kind = storage.kind;
    this.statTtlMs = Math.max(0, options.statTtlMs ?? 1_000);
    this.listTtlMs = Math.max(0, options.listTtlMs ?? 2_000);
    const maxEntries = options.maxEntries ?? 4096;
    const maxWeight = options.maxListItems ?? 65536;
    this.stats = new LruCache({ maxEntries });
    this.lists = new LruCache({ maxEntries, maxWeight, weightOf: (entry) => Math.max(1, entry.value.length) });
    this.directories = new LruCache({ maxEntries, maxWeight, weightOf: (entry) => Math.max(1, entry.value.length) });
  }

  private clearMetadata(): void {
    // A request started before a write must not repopulate the cache afterward.
    this.generation++;
    this.stats.clear();
    this.lists.clear();
    this.directories.clear();
    this.inflight.clear();
  }

  private async cached<T>(
    namespace: 'stat' | 'list' | 'directories',
    cache: LruCache<string, CacheEntry<T>>,
    key: string,
    ttlMs: number,
    load: () => Promise<T>,
  ): Promise<T> {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) return hit.value;
    cache.delete(key);
    const pendingKey = `${namespace}:${key}`;
    const pending = this.inflight.get(pendingKey) as Promise<T> | undefined;
    if (pending) return pending;
    const generation = this.generation;
    const request = load();
    this.inflight.set(pendingKey, request);
    try {
      const value = await request;
      if (generation === this.generation && ttlMs > 0) {
        cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      }
      return value;
    } finally {
      if (this.inflight.get(pendingKey) === request) this.inflight.delete(pendingKey);
    }
  }

  read(filePath: string) {
    return this.storage.read(filePath);
  }
  readRange(filePath: string, start: number, length: number) {
    return this.storage.readRange(filePath, start, length);
  }
  async write(filePath: string, bytes: Uint8Array, contentType?: string): Promise<void> {
    await this.storage.write(filePath, bytes, contentType);
    this.clearMetadata();
  }
  async replace(filePath: string, bytes: Uint8Array, contentType?: string): Promise<void> {
    const backend = this.storage as Partial<import('@violet-map/core/storage').AtomicObjectStorage>;
    if (!backend.replace) throw new Error('storage does not support atomic replacement');
    await backend.replace(filePath, bytes, contentType);
    this.clearMetadata();
  }
  async delete(filePath: string): Promise<void> {
    await this.storage.delete(filePath);
    this.clearMetadata();
  }
  async deletePrefix(prefix: string): Promise<number> {
    const deleted = await this.storage.deletePrefix(prefix);
    this.clearMetadata();
    return deleted;
  }
  stat(filePath: string) {
    const key = cleanStoragePath(filePath);
    return this.cached('stat', this.stats, key, this.statTtlMs, () => this.storage.stat(key));
  }
  list(prefix = '') {
    const key = cleanStoragePath(prefix);
    return this.cached('list', this.lists, key, this.listTtlMs, () => this.storage.list(key));
  }
  listDirectories(prefix = '') {
    const key = cleanStoragePath(prefix);
    return this.cached('directories', this.directories, key, this.listTtlMs, () => this.storage.listDirectories(key));
  }
}
