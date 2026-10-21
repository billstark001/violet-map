import { LruCache } from '@violet-map/core/cache';
import type { ObjectStorage, StoredFileInfo } from '@violet-map/core/storage';
import type { ObjectCapabilities } from './capabilities.js';
import { cleanStoragePath } from './paths.js';

export interface StorageCacheOptions {
  onMutation?: () => void;
  metadataBytes?: number;
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
  keyBytes: number;
  value: T;
}

/**
 * Short-TTL metadata cache for a shared storage backend. It coalesces repeated
 * stat/list calls without caching world bytes. Mutation attempts clear every
 * metadata entry, including backend failures that may have partially written.
 */
export class CachedStorage implements ObjectStorage {
  readonly scan?: ObjectCapabilities['scan'];
  readonly create?: ObjectCapabilities['create'];
  readonly readDocument?: ObjectCapabilities['readDocument'];
  readonly compareExchange?: ObjectCapabilities['compareExchange'];
  readonly replace?: ObjectCapabilities['replace'];
  readonly kind: ObjectStorage['kind'];
  readonly metrics = {
    get: 0,
    head: 0,
    list: 0,
    put: 0,
    delete: 0,
    readBytes: 0,
    uploadedBytes: 0,
    conditionalCreateAttempts: 0,
    conditionalDocumentAttempts: 0,
  };
  private readonly statTtlMs: number;
  private readonly listTtlMs: number;
  private readonly stats: LruCache<string, CacheEntry<StoredFileInfo | null>>;
  private readonly lists: LruCache<string, CacheEntry<StoredFileInfo[]>>;
  private readonly directories: LruCache<string, CacheEntry<string[]>>;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private generation = 0;
  private readonly onMutation?: () => void;

  constructor(
    private readonly storage: ObjectStorage,
    options: StorageCacheOptions = {},
  ) {
    const backend = storage as ObjectStorage & Partial<ObjectCapabilities>;
    if (backend.scan)
      this.scan = async function* (this: CachedStorage, prefix = '') {
        this.metrics.list++;
        yield* backend.scan!(prefix);
      }.bind(this);
    if (backend.create)
      this.create = (filePath, bytes, metadata) => {
        return this.mutate(async () => {
          this.metrics.conditionalCreateAttempts++;
          const created = await backend.create!(filePath, bytes, metadata);
          if (created) {
            this.metrics.put++;
            this.metrics.uploadedBytes += bytes.length;
          }
          return created;
        });
      };
    if (backend.readDocument)
      this.readDocument = (filePath, maxBytes) => {
        this.metrics.get++;
        return backend.readDocument!(filePath, maxBytes).then((document) => {
          this.metrics.readBytes += document?.bytes.length ?? 0;
          return document;
        });
      };
    if (backend.compareExchange)
      this.compareExchange = (filePath, expectedToken, bytes) => {
        return this.mutate(async () => {
          this.metrics.conditionalDocumentAttempts++;
          const committed = await backend.compareExchange!(filePath, expectedToken, bytes);
          if (committed) {
            this.metrics.put++;
            this.metrics.uploadedBytes += bytes.length;
          }
          return committed;
        });
      };
    if (backend.replace)
      this.replace = async (filePath, bytes, contentType) => {
        return this.mutate(async () => {
          await backend.replace!(filePath, bytes, contentType);
          this.metrics.put++;
          this.metrics.uploadedBytes += bytes.length;
        });
      };

    this.kind = storage.kind;
    this.onMutation = options.onMutation;
    this.statTtlMs = Math.max(0, options.statTtlMs ?? 1_000);
    this.listTtlMs = Math.max(0, options.listTtlMs ?? 2_000);
    const maxEntries = options.maxEntries ?? 4096;
    const maxWeight = options.maxListItems ?? 65536;
    if (options.metadataBytes !== undefined) {
      if (!Number.isSafeInteger(options.metadataBytes) || options.metadataBytes < 0)
        throw new RangeError('invalid storage metadata budget');
      const bytes = Math.floor(options.metadataBytes / 3);
      const weightOf = (entry: CacheEntry<unknown>) =>
        256 + entry.keyBytes + new TextEncoder().encode(JSON.stringify(entry.value)).byteLength * 4;
      this.stats = new LruCache<string, CacheEntry<StoredFileInfo | null>>({ maxEntries, maxWeight: bytes, weightOf });
      this.lists = new LruCache<string, CacheEntry<StoredFileInfo[]>>({ maxEntries, maxWeight: bytes, weightOf });
      this.directories = new LruCache<string, CacheEntry<string[]>>({ maxEntries, maxWeight: bytes, weightOf });
    } else {
      this.stats = new LruCache({ maxEntries });
      this.lists = new LruCache({ maxEntries, maxWeight, weightOf: (entry) => Math.max(1, entry.value.length) });
      this.directories = new LruCache({ maxEntries, maxWeight, weightOf: (entry) => Math.max(1, entry.value.length) });
    }
  }

  private clearMetadata(): void {
    // A request started before a write must not repopulate the cache afterward.
    this.generation++;
    this.onMutation?.();
    this.stats.clear();
    this.lists.clear();
    this.directories.clear();
    this.inflight.clear();
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      this.clearMetadata();
    }
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
        cache.set(key, { value, expiresAt: Date.now() + ttlMs, keyBytes: key.length * 2 });
      }
      return value;
    } finally {
      if (this.inflight.get(pendingKey) === request) this.inflight.delete(pendingKey);
    }
  }

  read(filePath: string) {
    this.metrics.get++;
    return this.storage.read(filePath).then((bytes) => {
      this.metrics.readBytes += bytes?.length ?? 0;
      return bytes;
    });
  }
  readRange(filePath: string, start: number, length: number) {
    this.metrics.get++;
    return this.storage.readRange(filePath, start, length).then((bytes) => {
      this.metrics.readBytes += bytes?.length ?? 0;
      return bytes;
    });
  }
  write(filePath: string, bytes: Uint8Array, contentType?: string): Promise<void> {
    return this.mutate(async () => {
      await this.storage.write(filePath, bytes, contentType);
      this.metrics.put++;
      this.metrics.uploadedBytes += bytes.length;
    });
  }

  delete(filePath: string): Promise<void> {
    return this.mutate(async () => {
      await this.storage.delete(filePath);
      this.metrics.delete++;
    });
  }
  deletePrefix(prefix: string): Promise<number> {
    return this.mutate(() => this.storage.deletePrefix(prefix));
  }
  stat(filePath: string) {
    const key = cleanStoragePath(filePath);
    return this.cached('stat', this.stats, key, this.statTtlMs, () => {
      this.metrics.head++;
      return this.storage.stat(key);
    });
  }
  list(prefix = '') {
    const key = cleanStoragePath(prefix);
    return this.cached('list', this.lists, key, this.listTtlMs, () => {
      this.metrics.list++;
      return this.storage.list(key);
    });
  }
  listDirectories(prefix = '') {
    const key = cleanStoragePath(prefix);
    return this.cached('directories', this.directories, key, this.listTtlMs, () => {
      this.metrics.list++;
      return this.storage.listDirectories(key);
    });
  }
}
