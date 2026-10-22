import type { ChunkState } from '../scheduling/contracts';

interface IoEntry {
  key: string;
  state: ChunkState;
  ioRequest?: symbol;
}

/** One executor-owned lease per entry; late results cannot cross entry or request generations. */
export class ChunkIoBatch<E extends IoEntry> {
  private readonly leases = new Map<string, { entry: E; token: symbol }>();
  constructor(
    entries: readonly E[],
    private readonly state: 'resolving' | 'fetching',
  ) {
    for (const entry of entries) {
      const token = Symbol(state);
      entry.ioRequest = token;
      entry.state = state;
      this.leases.set(entry.key, { entry, token });
    }
  }
  current(key: string, entries: ReadonlyMap<string, E>): E | undefined {
    const lease = this.leases.get(key);
    return lease &&
      entries.get(key) === lease.entry &&
      lease.entry.ioRequest === lease.token &&
      lease.entry.state === this.state
      ? lease.entry
      : undefined;
  }
  release() {
    for (const { entry, token } of this.leases.values()) if (entry.ioRequest === token) entry.ioRequest = undefined;
    this.leases.clear();
  }
}
