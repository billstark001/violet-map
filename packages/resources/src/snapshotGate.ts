import { ResourceError } from '@violet-map/core/resources';

export interface SnapshotToken {
  readonly id: number;
}

interface Waiting {
  write: boolean;
  start(): void;
}

/** Bounded in-process reader/writer barrier. Tokens permit nested work in the same fixed snapshot. */
export class SnapshotGate {
  private nextToken = 0;
  private readers = 0;
  private writer = false;
  private readonly queue: Waiting[] = [];
  private readonly tokens = new Set<SnapshotToken>();
  constructor(
    private readonly maxQueued = 64,
    private readonly maxReaders = 32,
  ) {}
  private drain() {
    if (this.writer) return;
    if (this.queue[0]?.write) {
      if (this.readers === 0) this.queue.shift()!.start();
      return;
    }
    while (this.queue.length && !this.queue[0].write && this.readers < this.maxReaders) this.queue.shift()!.start();
  }
  private async run<T>(
    write: boolean,
    operation: (token: SnapshotToken) => Promise<T>,
    existing?: SnapshotToken,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (existing) {
      if (!this.tokens.has(existing))
        throw new ResourceError('SOURCE_SNAPSHOT_CHANGED', 'snapshot token is no longer active');
      return operation(existing);
    }
    if (this.queue.length >= this.maxQueued)
      throw new ResourceError('RESOURCE_BUSY', 'source snapshot queue exhausted', true);
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = this.queue.indexOf(waiting);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal!.reason);
        this.drain();
      };
      const start = () => {
        signal?.removeEventListener('abort', abort);
        if (write) this.writer = true;
        else this.readers++;
        resolve();
      };
      const waiting = { write, start };
      if (!this.writer && !this.queue.length && (write ? this.readers === 0 : this.readers < this.maxReaders)) start();
      else {
        this.queue.push(waiting);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      }
    });
    const token = { id: ++this.nextToken };
    this.tokens.add(token);
    try {
      signal?.throwIfAborted();
      return await operation(token);
    } finally {
      this.tokens.delete(token);
      if (write) this.writer = false;
      else this.readers--;
      this.drain();
    }
  }
  read<T>(operation: (token: SnapshotToken) => Promise<T>, token?: SnapshotToken, signal?: AbortSignal) {
    return this.run(false, operation, token, signal);
  }
  write<T>(operation: (token: SnapshotToken) => Promise<T>, signal?: AbortSignal) {
    return this.run(true, operation, undefined, signal);
  }
}
