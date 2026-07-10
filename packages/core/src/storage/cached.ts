import type { StoredFileInfo, WorldStorage } from './types.js';

export interface StorageCacheOptions {
  /** Cache metadata probes; defaults are intentionally short to tolerate external writers. */
  statTtlMs?: number;
  listTtlMs?: number;
}

interface CacheEntry<T> { expiresAt: number; value: T; }

/**
 * Short-TTL metadata cache for a shared storage backend. It coalesces repeated
 * stat/list calls without caching world bytes. Writes clear every metadata entry
 * so normal server mutations are visible immediately.
 */
export class CachedWorldStorage implements WorldStorage {
  readonly kind: WorldStorage['kind'];
  private readonly statTtlMs: number;
  private readonly listTtlMs: number;
  private readonly stats = new Map<string, CacheEntry<StoredFileInfo | null>>();
  private readonly lists = new Map<string, CacheEntry<StoredFileInfo[]>>();
  private readonly directories = new Map<string, CacheEntry<string[]>>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly storage: WorldStorage, options: StorageCacheOptions = {}) {
    this.kind = storage.kind;
    this.statTtlMs = Math.max(0, options.statTtlMs ?? 1_000);
    this.listTtlMs = Math.max(0, options.listTtlMs ?? 2_000);
  }

  private clearMetadata(): void {
    this.stats.clear();
    this.lists.clear();
    this.directories.clear();
  }

  private async cached<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    ttlMs: number,
    load: () => Promise<T>,
  ): Promise<T> {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) return hit.value;
    const pendingKey = `${cache === this.stats ? 's' : cache === this.lists ? 'l' : 'd'}:${key}`;
    const pending = this.inflight.get(pendingKey) as Promise<T> | undefined;
    if (pending) return pending;
    const request = load();
    this.inflight.set(pendingKey, request);
    try {
      const value = await request;
      cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    } finally {
      if (this.inflight.get(pendingKey) === request) this.inflight.delete(pendingKey);
    }
  }

  read(filePath: string) { return this.storage.read(filePath); }
  readRange(filePath: string, start: number, length: number) { return this.storage.readRange(filePath, start, length); }
  async write(filePath: string, bytes: Uint8Array, contentType?: string): Promise<void> {
    await this.storage.write(filePath, bytes, contentType);
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
  stat(filePath: string) { return this.cached(this.stats, filePath, this.statTtlMs, () => this.storage.stat(filePath)); }
  list(prefix = '') { return this.cached(this.lists, prefix, this.listTtlMs, () => this.storage.list(prefix)); }
  listDirectories(prefix = '') { return this.cached(this.directories, prefix, this.listTtlMs, () => this.storage.listDirectories(prefix)); }
}
