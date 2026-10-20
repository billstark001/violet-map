import { ResourceError, type SourceRevision } from '@violet-map/core/resources';
import type { ObjectReader } from '@violet-map/core/storage';
import { sha256 } from '@violet-map/storage';
import type { InvalidationCoordinator } from './invalidation.js';

export interface SourceSnapshot {
  sourceScope: string;
  generation: number;
  read(key: string): Promise<Uint8Array | null>;
  revision(key: string): Promise<SourceRevision | null>;
  validate(): Promise<void>;
}

/** A snapshot requires a caller-held freeze, never an equal weak stat before and after. */
export function sourceSnapshot(
  reader: ObjectReader,
  coordinator: InvalidationCoordinator,
  sourceScope: string,
  freeze: { validate(): Promise<void> },
): SourceSnapshot {
  const generation = coordinator.generation;
  const read = async (key: string) => {
    coordinator.assert(generation);
    await freeze.validate();
    const bytes = await reader.read(key);
    await freeze.validate();
    coordinator.assert(generation);
    return bytes;
  };
  return {
    sourceScope,
    generation,
    read,
    async revision(key) {
      const bytes = await read(key);
      return bytes ? { token: sha256(bytes), strength: 'immutable' } : null;
    },
    async validate() {
      coordinator.assert(generation);
      await freeze.validate();
    },
  };
}

/** Explicit bounded source validation reads content when no reliable fixed version is available. */
export class BoundedSource {
  private lastCheck = 0;
  private observed?: string;
  sourceObservedAt = 0;
  private pending?: Promise<void>;
  constructor(
    private readonly coordinator: InvalidationCoordinator,
    private readonly observe: () => Promise<string>,
    private readonly revalidateMs = 5000,
  ) {
    if (!Number.isSafeInteger(revalidateMs) || revalidateMs < 1 || revalidateMs > 5000)
      throw new RangeError('bounded source revalidation must be 1..5000 ms');
  }
  async drain() {
    await this.pending;
  }
  async validate(force = false) {
    if (this.pending) return this.pending;
    if (!force && Date.now() - this.lastCheck < this.revalidateMs) return;
    const pending = (async () => {
      const digest = await this.observe();
      if (!/^[a-f0-9]{64}$/.test(digest))
        throw new ResourceError('RESOURCE_INTEGRITY_FAILED', 'invalid source observation');
      if (this.observed !== undefined && digest !== this.observed) this.coordinator.invalidate();
      this.observed = digest;
      this.lastCheck = Date.now();
      this.sourceObservedAt = this.lastCheck;
    })();
    this.pending = pending;
    try {
      await pending;
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }
}
