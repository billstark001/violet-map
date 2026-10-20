import { ResourceError } from '@violet-map/core/resources';

export class Singleflight {
  private readonly pending = new Map<string, Promise<unknown>>();
  private closing = false;
  private readonly waiters = new Map<string, number>();
  coalesced = 0;
  constructor(private readonly maxPending: number) {
    if (!Number.isSafeInteger(maxPending) || maxPending < 1)
      throw new RangeError('singleflight needs a positive task limit');
  }
  get size() {
    return this.pending.size;
  }
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new ResourceError('RESOURCE_BUSY', 'resource service is closing', true));
    if (key.length > 8192)
      return Promise.reject(new ResourceError('RESOURCE_BUSY', 'resource task key exceeds metadata budget'));
    const existing = this.pending.get(key);
    if (existing) {
      const count = this.waiters.get(key) ?? 1;
      if (count >= 256)
        return Promise.reject(new ResourceError('RESOURCE_BUSY', 'resource waiter budget exhausted', true));
      this.waiters.set(key, count + 1);
      this.coalesced++;
      return existing as Promise<T>;
    }
    if (this.pending.size >= this.maxPending)
      return Promise.reject(new ResourceError('RESOURCE_BUSY', 'resource task limit exhausted', true));
    const promise = Promise.resolve()
      .then(task)
      .finally(() => {
        if (this.pending.get(key) === promise) {
          this.pending.delete(key);
          this.waiters.delete(key);
        }
      });
    this.pending.set(key, promise);
    return promise;
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.pending.values());
  }
}
