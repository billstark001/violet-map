import { ResourceError } from '@violet-map/core/resources';

interface Task<T> {
  controller: AbortController;
  promise: Promise<T>;
  users: number;
  delivered: boolean;
  settled: boolean;
  hasValue: boolean;
  value?: T;
  disposed: boolean;
  ownership?: { acquire?(value: T): T; release(value: T): void };
}

export class Singleflight {
  private readonly pending = new Map<string, Task<unknown>>();
  private readonly active = new Set<Task<unknown>>();
  private closing = false;
  coalesced = 0;
  constructor(private readonly maxPending: number) {
    if (!Number.isSafeInteger(maxPending) || maxPending < 1)
      throw new RangeError('singleflight needs a positive task limit');
  }
  get size() {
    return this.active.size;
  }
  private dispose<T>(job: Task<T>) {
    if (job.settled && !job.users && job.hasValue && !job.disposed && (!job.delivered || job.ownership?.acquire)) {
      job.disposed = true;
      job.ownership?.release(job.value!);
    }
  }
  run<T>(
    key: string,
    task: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    ownership?: { acquire?(value: T): T; release(value: T): void },
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.closing) return Promise.reject(new ResourceError('RESOURCE_BUSY', 'resource service is closing', true));
    if (key.length > 8192)
      return Promise.reject(new ResourceError('RESOURCE_BUSY', 'resource task key exceeds metadata budget'));
    let job = this.pending.get(key) as Task<T> | undefined;
    if (job && !job.controller.signal.aborted) {
      if (job.users >= 256)
        return Promise.reject(new ResourceError('RESOURCE_BUSY', 'resource waiter budget exhausted', true));
      this.coalesced++;
    } else {
      if (this.active.size >= this.maxPending)
        return Promise.reject(new ResourceError('RESOURCE_BUSY', 'resource task limit exhausted', true));
      const controller = new AbortController();
      const owned: Task<T> = {
        controller,
        users: 0,
        delivered: false,
        settled: false,
        hasValue: false,
        disposed: false,
        ownership,
        promise: undefined!,
      };
      owned.promise = Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted();
          return task(controller.signal);
        })
        .then((value) => {
          owned.value = value;
          owned.hasValue = true;
          return value;
        })
        .finally(() => {
          owned.settled = true;
          this.active.delete(owned as Task<unknown>);
          if (this.pending.get(key) === owned) {
            this.pending.delete(key);
          }
          this.dispose(owned);
        });
      // Cancellation can outlive an uninterruptible backend read. Its slot stays
      // charged until settlement; retiring cleanup cannot remove a replacement.
      this.pending.set(key, owned as Task<unknown>);
      this.active.add(owned as Task<unknown>);
      job = owned;
    }
    const shared = job;
    shared.users++;
    let abort: (() => void) | undefined;
    const result = signal
      ? Promise.race([
          shared.promise,
          new Promise<never>((_resolve, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          }),
        ])
      : shared.promise;
    return result
      .then((value) => {
        signal?.throwIfAborted();
        // Acquire each caller's ownership before its continuation can release
        // anything. The producer remains pinned until every waiter has done so.
        const retained = shared.ownership?.acquire ? shared.ownership.acquire(value) : value;
        shared.delivered = true;
        return retained;
      })
      .finally(() => {
        if (abort) signal?.removeEventListener('abort', abort);
        if (--shared.users === 0) {
          if (!shared.settled) shared.controller.abort(new DOMException('resource task has no owners', 'AbortError'));
          else this.dispose(shared);
        }
      });
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const job of this.active)
      job.controller.abort(new ResourceError('RESOURCE_BUSY', 'resource service is closing', true));
    await this.drain();
  }
  /** Wait for admitted work without accepting an unbounded queue or closing it. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.active].map((job) => job.promise));
  }
}
