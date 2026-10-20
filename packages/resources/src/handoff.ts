import { ResourceError } from '@violet-map/core/resources';
import { ByteBudget, byteCapacity } from './budget.js';

/** Short promises of availability are charged independently from optional retention. */
export class HandoffStore {
  private readonly entries = new Map<
    string,
    { bytes: Uint8Array; until: number; claims: number; release: () => void }
  >();
  private reservedEntries = 0;
  private timer?: ReturnType<typeof setTimeout>;
  readonly budget: ByteBudget;
  expired = 0;
  constructor(
    bytes: number,
    readonly lifetimeMs: number,
    private readonly now = Date.now,
    private readonly maxEntries = 4096,
  ) {
    this.budget = new ByteBudget(bytes);
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1) throw new RangeError('handoff lifetime must be positive');
  }
  sweep() {
    const now = this.now();
    for (const [key, entry] of this.entries)
      if (entry.until <= now) {
        this.release(key);
        this.expired++;
      }
  }
  reserve(maxBytes: number, artifacts = 1) {
    this.sweep();
    byteCapacity(artifacts);
    if (artifacts < 1 || this.entries.size + this.reservedEntries > this.maxEntries - artifacts)
      throw new ResourceError('RESOURCE_BUSY', 'handoff metadata budget exhausted', true);
    const releaseBytes = this.budget.reserve(Math.max(1, byteCapacity(maxBytes)));
    this.reservedEntries += artifacts;
    let active = true;
    return () => {
      if (active) {
        active = false;
        this.reservedEntries -= artifacts;
        releaseBytes();
      }
    };
  }
  private schedule(until: number) {
    if (this.timer) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.sweep();
        const first = this.entries.values().next().value;
        if (first) this.schedule(first.until);
      },
      Math.min(2147483647, Math.max(1, until - this.now())),
    );
    this.timer.unref();
  }
  put(key: string, bytes: Uint8Array): number {
    this.sweep();
    const existing = this.entries.get(key);
    if (existing) return existing.until;
    if (this.entries.size >= this.maxEntries)
      throw new ResourceError('RESOURCE_BUSY', 'handoff metadata budget exhausted', true);
    const release = this.budget.reserve(Math.max(1, bytes.byteLength));
    const until = this.now() + this.lifetimeMs;
    this.entries.set(key, { bytes, until, claims: 0, release });
    this.schedule(until);
    return until;
  }
  get(key: string): { bytes: Uint8Array; validUntil: number } | undefined {
    this.sweep();
    const entry = this.entries.get(key);
    return entry ? { bytes: entry.bytes, validUntil: entry.until } : undefined;
  }
  claim(key: string): number {
    this.sweep();
    const entry = this.entries.get(key);
    if (!entry)
      throw new ResourceError('RESOURCE_VIEW_EXPIRED', 'handoff expired before its reference was issued', true);
    if (entry.claims >= 256) throw new ResourceError('RESOURCE_BUSY', 'resource handoff waiter budget exhausted', true);
    entry.claims++;
    entry.until = Math.max(entry.until, this.now() + this.lifetimeMs);
    return entry.until;
  }
  consume(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.claims > 1) entry.claims--;
    else this.release(key);
  }
  releaseUnclaimed(key: string) {
    const entry = this.entries.get(key);
    if (entry && entry.claims === 0) this.release(key);
  }
  release(key: string) {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      entry.release();
    }
  }
  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const key of this.entries.keys()) this.release(key);
  }
}
