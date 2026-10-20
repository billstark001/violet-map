import { ResourceError } from '@violet-map/core/resources';

export function byteCapacity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError('byte capacity must be a nonnegative safe integer');
  return value;
}

/** Reservations precede allocation. No unbounded implicit waiting queue. */
export class ByteBudget {
  private used = 0;
  private limit: number;
  private readonly waiting: { bytes: number; resume(): void }[] = [];
  get queuedBytes() {
    return this.waiting.reduce((sum, waiter) => sum + waiter.bytes, 0);
  }
  get queuedTasks() {
    return this.waiting.length;
  }
  constructor(bytes: number) {
    this.limit = byteCapacity(bytes);
  }
  get bytes() {
    return this.used;
  }
  get capacity() {
    return this.limit;
  }
  get draining() {
    return this.used > this.limit;
  }
  resize(bytes: number) {
    this.limit = byteCapacity(bytes);
    this.wake();
  }
  private wake() {
    for (const waiter of [...this.waiting]) {
      if (waiter.bytes <= this.limit && this.used > this.limit - waiter.bytes) break;
      waiter.resume();
    }
  }
  async waitReserve(bytes: number, maxQueued: number, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    byteCapacity(bytes);
    if (bytes > this.limit) throw new ResourceError('RESOURCE_BUSY', 'generator exceeds work capacity', true);
    const immediate = this.tryReserve(bytes);
    if (immediate) return immediate;
    if (this.waiting.length >= maxQueued) throw new ResourceError('RESOURCE_BUSY', 'work queue exhausted', true);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        const index = this.waiting.indexOf(waiter);
        if (index !== -1) this.waiting.splice(index, 1);
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
        this.wake();
      };
      const waiter = {
        bytes,
        resume: () => {
          if (bytes > this.limit) {
            cleanup();
            reject(new ResourceError('RESOURCE_BUSY', 'work capacity shrank', true));
            return;
          }
          const release = this.tryReserve(bytes);
          if (release) {
            cleanup();
            resolve(release);
          }
        },
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new ResourceError('RESOURCE_BUSY', 'work queue deadline exceeded', true));
        this.wake();
      }, 30000);
      timer.unref();
      signal.addEventListener('abort', abort, { once: true });
      this.waiting.push(waiter);
      if (signal.aborted) abort();
    });
  }
  reserve(bytes: number): () => void {
    const release = this.tryReserve(bytes);
    if (!release) throw new ResourceError('RESOURCE_BUSY', 'resource work budget exhausted', true);
    return release;
  }
  tryReserve(bytes: number): (() => void) | undefined {
    byteCapacity(bytes);
    if (this.used > this.limit - bytes) return undefined;
    this.used += bytes;
    let active = true;
    return () => {
      if (active) {
        this.used -= bytes;
        active = false;
        this.wake();
      }
    };
  }
}
