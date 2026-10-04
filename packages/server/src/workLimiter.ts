/** Runs async work with bounded concurrency and a bounded waiting queue. */
export class WorkLimiter {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
    private readonly busyError: () => Error,
  ) {
    if (
      !Number.isSafeInteger(maxConcurrent) ||
      maxConcurrent < 1 ||
      !Number.isSafeInteger(maxQueued) ||
      maxQueued < 0
    ) {
      throw new RangeError('invalid work limits');
    }
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active < this.maxConcurrent && this.waiters.length === 0) {
      this.active++;
    } else {
      if (this.waiters.length >= this.maxQueued) throw this.busyError();
      // The finishing task transfers its active slot directly to this waiter.
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    try {
      return await work();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}
