import { byteCapacity } from './budget.js';

interface Entry<V> {
  value: V;
  bytes: number;
}

class Segment<V> extends Map<string, Entry<V>> {
  bytes = 0;
  override set(key: string, entry: Entry<V>): this {
    this.bytes -= this.get(key)?.bytes ?? 0;
    this.bytes += entry.bytes;
    return super.set(key, entry);
  }
  override delete(key: string): boolean {
    this.bytes -= this.get(key)?.bytes ?? 0;
    return super.delete(key);
  }
}

function* victims<V>(probation: Segment<V>, protectedSegment: Segment<V>) {
  yield* probation;
  yield* protectedSegment;
}

/** Fixed count-min sketch with saturating counters and bounded periodic aging. */
class Frequency {
  private readonly counts: Uint8Array;
  private readonly width: number;
  constructor(entries: number) {
    this.width = entries === 0 ? 0 : 2 ** Math.ceil(Math.log2(Math.max(16, Math.min(1024, entries))));
    this.counts = new Uint8Array(this.width * 4);
  }
  private samples = 0;
  private slots(key: string): number[] {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
    return [
      h & (this.width - 1),
      this.width + ((h >>> 10) & (this.width - 1)),
      this.width * 2 + ((h >>> 20) & (this.width - 1)),
      this.width * 3 + ((Math.imul(h, 0x9e3779b1) >>> 16) & (this.width - 1)),
    ];
  }
  add(key: string) {
    for (const slot of this.slots(key)) if (this.counts[slot] < 15) this.counts[slot]++;
    if (++this.samples >= 40960) {
      for (let i = 0; i < this.counts.length; i++) this.counts[i] >>>= 1;
      this.samples >>>= 1;
    }
  }
  get(key: string) {
    return Math.min(...this.slots(key).map((slot) => this.counts[slot]));
  }
}

/** Byte-weighted window TinyLFU: recency window, probation and protected main segments. */
export class ResourceCache<V> {
  private readonly window = new Segment<V>();
  private readonly probation = new Segment<V>();
  private readonly protected = new Segment<V>();
  private frequency: Frequency;
  private limit: number;
  private retained = 0;
  private requests = 0;
  private sampleRequests = 0;
  private sampleHits = 0;
  private fillPaused = false;
  private record(hit: boolean) {
    this.sampleRequests++;
    if (hit) this.sampleHits++;
    if (this.fillPaused && this.sampleHits >= 2) {
      this.fillPaused = false;
      this.metrics.fillResumed++;
    }
    if (this.sampleRequests === 64) {
      if (this.sampleHits < 2 && this.size && !this.fillPaused) {
        this.fillPaused = true;
        this.metrics.fillPaused++;
      }
      this.sampleRequests = 0;
      this.sampleHits = 0;
    }
  }
  readonly metrics = {
    hit: 0,
    miss: 0,
    eviction: 0,
    oversizedReject: 0,
    admissionReject: 0,
    disabledReject: 0,
    fillPaused: 0,
    fillResumed: 0,
    fillPausedReject: 0,
  };
  constructor(
    bytes: number,
    private readonly maxEntries = 4096,
    private readonly evicted?: (key: string, value: V) => void,
  ) {
    this.limit = byteCapacity(bytes);
    byteCapacity(maxEntries);
    this.frequency = new Frequency(bytes ? maxEntries : 0);
  }
  get bytes() {
    return this.retained;
  }
  get capacity() {
    return this.limit;
  }
  get size() {
    return this.window.size + this.probation.size + this.protected.size;
  }
  private touch(segment: Map<string, Entry<V>>, key: string, entry: Entry<V>) {
    segment.delete(key);
    segment.set(key, entry);
  }
  get(key: string): V | undefined {
    this.requests++;
    if (!this.size) {
      this.metrics.miss++;
      this.record(false);
      return undefined;
    }
    if (!this.fillPaused || this.requests % 64 === 0) this.frequency.add(key);
    for (const segment of [this.window, this.protected, this.probation]) {
      const entry = segment.get(key);
      if (!entry) continue;
      this.metrics.hit++;
      this.record(true);
      if (segment === this.probation) {
        segment.delete(key);
        this.protected.set(key, entry);
        const protectedLimit = Math.floor(this.limit * 0.8);
        while (this.protected.bytes > protectedLimit && this.protected.size) {
          const [coldKey, cold] = this.protected.entries().next().value!;
          this.protected.delete(coldKey);
          this.probation.set(coldKey, cold);
        }
      } else this.touch(segment, key, entry);
      return entry.value;
    }
    this.metrics.miss++;
    this.record(false);
    return undefined;
  }
  delete(key: string): boolean {
    for (const segment of [this.window, this.probation, this.protected]) {
      const entry = segment.get(key);
      if (entry) {
        segment.delete(key);
        this.retained -= entry.bytes;
        this.evicted?.(key, entry.value);
        return true;
      }
    }
    return false;
  }
  set(key: string, value: V, bytes: number): boolean {
    byteCapacity(bytes);
    if (key.length > 256) throw new RangeError('resource cache key exceeds metadata limits');
    // Charge at least one byte so empty values cannot create unbounded maps.
    bytes = Math.max(1, bytes);
    if (!this.limit || !this.maxEntries) {
      this.metrics.disabledReject++;
      return false;
    }
    if (bytes > this.limit) {
      this.metrics.oversizedReject++;
      return false;
    }
    if (this.fillPaused && this.requests % 64 !== 0) {
      this.metrics.fillPausedReject++;
      return false;
    }
    this.delete(key);
    this.window.set(key, { value, bytes });
    this.retained += bytes;
    const windowLimit = Math.floor(this.limit * 0.01);
    while ((this.window.bytes > windowLimit || this.size > this.maxEntries) && this.window.size) {
      const [candidateKey, candidate] = this.window.entries().next().value!;
      this.window.delete(candidateKey);
      // Compare against every victim needed for a variable-sized candidate before evicting any.
      let reclaim = this.limit - this.retained;
      let reclaimEntries = Math.max(0, this.size + 1 - this.maxEntries);
      const evictedKeys: string[] = [];
      let admitted = true;
      for (const [victimKey, victim] of victims(this.probation, this.protected)) {
        if (reclaim >= 0 && reclaimEntries === 0) break;
        if (this.frequency.get(candidateKey) <= this.frequency.get(victimKey)) {
          admitted = false;
          break;
        }
        evictedKeys.push(victimKey);
        reclaim += victim.bytes;
        reclaimEntries = Math.max(0, reclaimEntries - 1);
      }
      if (!admitted || reclaim < 0 || reclaimEntries > 0) {
        this.retained -= candidate.bytes;
        this.evicted?.(candidateKey, candidate.value);
        this.metrics.admissionReject++;
        continue;
      }
      for (const victim of evictedKeys) {
        this.delete(victim);
        this.metrics.eviction++;
      }
      this.probation.set(candidateKey, candidate);
    }
    return this.window.has(key) || this.probation.has(key) || this.protected.has(key);
  }
  resize(bytes: number) {
    if (!this.limit && bytes > 0) {
      this.frequency = new Frequency(this.maxEntries);
      this.fillPaused = false;
      this.sampleRequests = this.sampleHits = 0;
    }
    this.limit = byteCapacity(bytes);
    for (const segment of [this.window, this.probation, this.protected]) {
      for (const key of segment.keys()) {
        if (this.retained <= this.limit) break;
        this.delete(key);
        this.metrics.eviction++;
      }
    }
  }
}
