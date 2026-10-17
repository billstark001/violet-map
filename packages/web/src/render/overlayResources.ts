import { OVERLAY_LIMITS } from './overlayLimits';

export interface DisposableOverlayResource {
  readonly bytes: number;
  dispose(): void;
}

interface Entry<T> {
  key: string;
  refs: number;
  abort: AbortController;
  promise: Promise<T>;
  resolve: (resource: T) => void;
  reject: (error: unknown) => void;
  load: (signal: AbortSignal) => Promise<T>;
  resource?: T;
  started: boolean;
}

export interface ResourceLease<T> {
  promise: Promise<T>;
  release(): void;
}

/** Ref-counted, bounded in-flight cache. Zero owners means immediate disposal, including late decodes. */
export class OverlayResourcePool<T extends DisposableOverlayResource> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly queue: Entry<T>[] = [];
  private running = 0;
  private residentBytes = 0;
  private disposed = false;
  constructor(
    private readonly maxBytes: number = OVERLAY_LIMITS.mediaBytes,
    private readonly maxEntries: number = OVERLAY_LIMITS.mediaVersions,
    private readonly concurrency: number = OVERLAY_LIMITS.parallelMediaLoads,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('invalid overlay byte budget');
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) throw new RangeError('invalid overlay version budget');
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError('invalid overlay load concurrency');
  }
  acquire(key: string, load: (signal: AbortSignal) => Promise<T>): ResourceLease<T> {
    if (this.disposed) throw new Error('overlay resource pool is disposed');
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxEntries) throw new Error('overlay media version budget exceeded');
      let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
      const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      entry = { key, refs: 0, abort: new AbortController(), promise, resolve, reject, load, started: false };
      promise.catch(() => {});
      this.entries.set(key, entry);
      this.queue.push(entry);
    }
    entry.refs++;
    let released = false;
    const owned = entry;
    this.pump();
    return {
      promise: entry.promise,
      release: () => {
        if (released) return;
        released = true;
        if (--owned.refs === 0) {
          owned.abort.abort();
          if (this.entries.get(key) === owned) this.entries.delete(key);
          if (owned.resource) {
            this.residentBytes -= owned.resource.bytes;
            owned.resource.dispose();
            owned.resource = undefined;
          }
          if (!owned.started) {
            owned.reject(new DOMException('overlay resource released', 'AbortError'));
            const index = this.queue.indexOf(owned);
            if (index >= 0) this.queue.splice(index, 1);
          }
        }
      },
    };
  }
  private pump() {
    while (!this.disposed && this.running < this.concurrency && this.queue.length) {
      const entry = this.queue.shift()!;
      if (entry.refs === 0) continue;
      entry.started = true;
      this.running++;
      Promise.resolve()
        .then(() => entry.load(entry.abort.signal))
        .then((resource) => {
          if (entry.abort.signal.aborted || this.disposed || !entry.refs) {
            resource.dispose();
            throw new DOMException('overlay resource released', 'AbortError');
          }
          if (
            !Number.isFinite(resource.bytes) ||
            resource.bytes < 0 ||
            this.residentBytes + resource.bytes > this.maxBytes
          ) {
            resource.dispose();
            throw new Error('overlay GPU resource budget exceeded');
          }
          this.residentBytes += resource.bytes;
          entry.resource = resource;
          entry.resolve(resource);
        })
        .catch((error) => {
          entry.reject(error);
          if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
        })
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }
  snapshot() {
    return {
      versions: this.entries.size,
      pending: this.running + this.queue.length,
      bytes: this.residentBytes,
      references: [...this.entries.values()].reduce((total, entry) => total + entry.refs, 0),
    };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) {
      entry.abort.abort();
      entry.refs = 0;
      if (entry.resource) {
        entry.resource.dispose();
        entry.resource = undefined;
      }
      if (!entry.started) entry.reject(new DOMException('overlay resource pool disposed', 'AbortError'));
    }
    this.entries.clear();
    this.queue.length = 0;
    this.residentBytes = 0;
  }
}
