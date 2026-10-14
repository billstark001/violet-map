/** Visit items with a fixed maximum number of simultaneous async operations. */
export async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  visit: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('concurrency limit must be positive');
  let next = 0;
  let failed = false;
  let failure: unknown;
  const worker = async () => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try {
        await visit(items[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failure;
}

/** Map items in input order while bounding simultaneous async operations. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  await forEachConcurrent(items, limit, async (item, index) => {
    results[index] = await map(item, index);
  });
  return results;
}

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
