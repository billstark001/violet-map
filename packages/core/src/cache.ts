export interface LruCacheOptions<V> {
  /** Maximum resident entries; zero disables retention. */
  maxEntries: number;
  /** Maximum combined weight; defaults to no weight limit. */
  maxWeight?: number;
  /** Called on insertion. Values must remain immutable while cached. Defaults to 1. */
  weightOf?: (value: V) => number;
}

/**
 * An insertion- and weight-bounded least-recently-used cache. Reads through
 * `get` refresh recency; `peek` and iteration do not. Oversized values are
 * returned to their caller normally but are never retained or allowed to evict
 * useful entries. Eviction only releases this cache's reference to a value.
 */
export class LruCache<K, V> implements Iterable<[K, V]> {
  private readonly entries = new Map<K, { value: V; weight: number }>();
  private readonly maxEntries: number;
  private readonly maxWeight: number;
  private readonly weightOf: (value: V) => number;
  private residentWeight = 0;

  constructor(options: LruCacheOptions<V>) {
    if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries < 0) {
      throw new RangeError('cache maxEntries must be a nonnegative safe integer');
    }
    const maxWeight = options.maxWeight ?? Infinity;
    if (!(maxWeight >= 0)) throw new RangeError('cache maxWeight must be nonnegative');
    this.maxEntries = options.maxEntries;
    this.maxWeight = maxWeight;
    this.weightOf = options.weightOf ?? (() => 1);
  }

  get size(): number {
    return this.entries.size;
  }
  get weight(): number {
    return this.residentWeight;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  peek(key: K): V | undefined {
    return this.entries.get(key)?.value;
  }
  has(key: K): boolean {
    return this.entries.has(key);
  }

  /** Replace an entry and evict the least recently used values as needed. */
  set(key: K, value: V): this {
    const weight = this.weightOf(value);
    if (!Number.isFinite(weight) || weight < 0)
      throw new RangeError('cache entry weight must be finite and nonnegative');
    this.delete(key);
    if (this.maxEntries === 0 || weight > this.maxWeight) return this;
    this.entries.set(key, { value, weight });
    this.residentWeight += weight;
    while (this.entries.size > this.maxEntries || this.residentWeight > this.maxWeight) {
      this.delete(this.entries.keys().next().value!);
    }
    return this;
  }

  delete(key: K): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.residentWeight -= entry.weight;
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.residentWeight = 0;
  }

  keys(): MapIterator<K> {
    return this.entries.keys();
  }
  *[Symbol.iterator](): IterableIterator<[K, V]> {
    for (const [key, entry] of this.entries) yield [key, entry.value];
  }
}
