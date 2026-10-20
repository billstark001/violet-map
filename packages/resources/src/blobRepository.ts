import { ResourceError, type ArtifactRef } from '@violet-map/core/resources';
import type { AtomicObjectStorage, ObjectReader } from '@violet-map/core/storage';
import {
  artifactRef,
  ContentAddressedStorage,
  verifyArtifact,
  type ConditionalObjectWriter,
} from '@violet-map/storage';
import { ByteBudget, byteCapacity } from './budget.js';
import { ResourceCache } from './cache.js';
import type { ActionIndex } from './catalog.js';
import { HandoffStore } from './handoff.js';
import type { InvalidationCoordinator } from './invalidation.js';
import type { PersistentResourceCache } from './persistentCache.js';
import { Singleflight } from './singleflight.js';

export interface PreparedResource {
  actionKey: string;
  generation: number;
  mediaType: string;
  format: string;
  maxBytes: number;
  workBytes: number;
  maxArtifacts?: number;
  related?(bytes: Uint8Array): readonly ArtifactRef[];
  generate(
    signal: AbortSignal,
  ): Promise<Uint8Array | { bytes: Uint8Array; related: { bytes: Uint8Array; mediaType: string; format: string }[] }>;
}

export interface ResourceAvailability {
  artifact: ArtifactRef;
  validUntil: number;
}

/** A producer/caller reservation, independent from the optional byte cache. */
export interface ResourceLease extends ResourceAvailability {
  artifacts: readonly ArtifactRef[];
  release(): void;
}

export interface ArtifactRead {
  bytes: Uint8Array;
  release(): void;
  transfer?(bytes: number): void;
}

export interface RepositoryOptions {
  memoryBytes: number;
  workBytes: number;
  handoffBytes: number;
  workBudget?: ByteBudget;
  handoffMs: number;
  maxTasks: number;
  readPublishedDerived?(ref: ArtifactRef): Promise<Uint8Array | null>;
  metadataEntries?: number;
  index: ActionIndex;
  source: InvalidationCoordinator;
  layers?: readonly PersistentResourceCache[];
}

interface Reservation {
  releaseWork(): void;
  releaseHandoff(): void;
  maxBytes: number;
  workBytes: number;
  maxArtifacts: number;
}

/** One repository handles derived bytes, authorized originals and publication copy inputs. */
export class BlobRepository {
  private readonly controller = new AbortController();
  private closing?: Promise<void>;
  readonly cache: ResourceCache<Uint8Array>;
  readonly work: ByteBudget;
  readonly handoff: HandoffStore;
  readonly tasks: Singleflight;
  readonly prepares: Singleflight;
  readonly metrics = {
    actionHit: 0,
    actionMiss: 0,
    generation: 0,
    handoffHit: 0,
    originalPut: 0,
    originalUploadedBytes: 0,
    apiBodyBytesEnqueued: 0,
  };
  constructor(private readonly options: RepositoryOptions) {
    if (options.workBytes <= 0 || options.handoffBytes <= 0)
      throw new RangeError('work and handoff budgets must be positive');
    this.cache = new ResourceCache(options.memoryBytes, options.metadataEntries ?? 4096);
    if (options.workBudget && options.workBudget.capacity !== options.workBytes)
      throw new RangeError('injected work budget must match the configured work capacity');
    this.work = options.workBudget ?? new ByteBudget(options.workBytes);
    this.handoff = new HandoffStore(options.handoffBytes, options.handoffMs, Date.now, options.metadataEntries ?? 4096);
    this.tasks = new Singleflight(options.maxTasks);
    this.prepares = new Singleflight(options.maxTasks);
  }
  private async reserve(maxBytes: number, workBytes: number, maxArtifacts = 1): Promise<Reservation> {
    byteCapacity(maxBytes);
    byteCapacity(workBytes);
    if (maxBytes < 1) throw new RangeError('invalid generator budget');
    if (workBytes < maxBytes)
      throw new ResourceError('RESOURCE_BUSY', 'generator output exceeds available work budget', true);
    const releaseWork = await this.work.waitReserve(workBytes, this.options.maxTasks, this.controller.signal);
    try {
      return {
        releaseWork,
        releaseHandoff: this.handoff.reserve(maxBytes, maxArtifacts),
        maxBytes,
        workBytes,
        maxArtifacts,
      };
    } catch (error) {
      releaseWork();
      throw error;
    }
  }
  lease(ref: ArtifactRef): ResourceAvailability | undefined {
    const pin = this.handoff.get(ref.digest);
    if (pin) return { artifact: ref, validUntil: pin.validUntil };
    const hit = this.cache.get(ref.digest);
    if (!hit) return undefined;
    return { artifact: ref, validUntil: this.handoff.put(ref.digest, hit) };
  }
  promise(ref: ArtifactRef): ResourceAvailability {
    if (!this.lease(ref))
      throw new ResourceError('RESOURCE_VIEW_EXPIRED', 'resource expired before resolve completed', true);
    return { artifact: ref, validUntil: this.handoff.claim(ref.digest) };
  }
  cancelPromise(ref: ArtifactRef) {
    this.handoff.consume(ref.digest);
  }
  async build(
    logicalKey: string,
    generation: number,
    maxBytes: number,
    workBytes: number,
    prepare: () => Promise<PreparedResource | null>,
    maxArtifacts = 1,
  ): Promise<(ResourceLease & { actionKey: string }) | null> {
    this.options.source.assert(generation);
    const held = await this.prepares.run(`${generation}:${logicalKey}`, async () => {
      const reservation = await this.reserve(maxBytes, workBytes, maxArtifacts);
      try {
        this.controller.signal.throwIfAborted();
        const action = await prepare();
        if (!action) return null;
        if (action.maxBytes > maxBytes || action.workBytes > workBytes || (action.maxArtifacts ?? 1) > maxArtifacts)
          throw new ResourceError('RESOURCE_BUSY', 'prepared action exceeds reserved work');
        return { ...(await this.run(action, reservation)), actionKey: action.actionKey };
      } finally {
        reservation.releaseHandoff();
        reservation.releaseWork();
      }
    });
    if (!held) return null;
    try {
      return { ...this.hold(held.artifacts), actionKey: held.actionKey };
    } finally {
      held.release();
    }
  }
  private hold(artifacts: readonly ArtifactRef[]): ResourceLease {
    const claimed: ArtifactRef[] = [];
    let validUntil = Infinity;
    try {
      for (const ref of artifacts) {
        validUntil = Math.min(validUntil, this.handoff.claim(ref.digest));
        claimed.push(ref);
      }
    } catch (error) {
      for (const ref of claimed) this.handoff.consume(ref.digest);
      throw error;
    }
    let active = true;
    return {
      artifact: artifacts[0],
      artifacts,
      validUntil,
      release: () => {
        if (active) {
          active = false;
          for (const ref of claimed) this.handoff.consume(ref.digest);
        }
      },
    };
  }
  async ensure(action: PreparedResource): Promise<ResourceLease> {
    const held = await this.run(action);
    try {
      return this.hold(held.artifacts);
    } finally {
      held.release();
    }
  }
  private run(action: PreparedResource, reservation?: Reservation): Promise<ResourceLease> {
    if (!/^[a-f0-9]{64}$/.test(action.actionKey)) throw new TypeError('invalid action key');
    this.options.source.assert(action.generation);
    return this.tasks.run(`${action.generation}:${action.actionKey}`, () => this.materialize(action, reservation));
  }
  private async materialize(action: PreparedResource, reservation?: Reservation): Promise<ResourceLease> {
    this.options.source.assert(action.generation);
    this.controller.signal.throwIfAborted();
    let known = await this.options.index.get(action.actionKey);
    for (const layer of this.options.layers ?? []) {
      if (known) break;
      known = await layer.action(action.actionKey);
    }
    this.options.source.assert(action.generation);
    this.controller.signal.throwIfAborted();
    if (known && (known.mediaType !== action.mediaType || known.format !== action.format))
      throw new ResourceError('RESOURCE_INTEGRITY_FAILED', 'action representation changed');
    if (known) {
      if (known.bytes > action.maxBytes)
        throw new ResourceError('RESOURCE_BUSY', 'stored artifact exceeds declared output budget');
      const lease = this.lease(known);
      if (lease && (!action.related || action.related(this.open(known)).every((ref) => Boolean(this.lease(ref))))) {
        this.metrics.actionHit++;
        return this.hold([known, ...(action.related?.(this.open(known)) ?? [])]);
      }
    }
    const owned = reservation ?? (await this.reserve(action.maxBytes, action.workBytes, action.maxArtifacts ?? 1));
    try {
      if (known) {
        const load = async (ref: ArtifactRef): Promise<Uint8Array | null> => {
          const pin = this.handoff.get(ref.digest);
          const hit = pin?.bytes ?? this.cache.get(ref.digest);
          if (hit) return hit;
          for (const layer of this.options.layers ?? []) {
            const bytes = await layer.read(ref);
            if (bytes) return bytes;
          }
          return this.options.readPublishedDerived ? this.options.readPublishedDerived(ref) : null;
        };
        const primary = await load(known);
        if (primary) {
          const refs = action.related?.(primary) ?? [];
          let sum = known.bytes;
          const outputs: { ref: ArtifactRef; bytes: Uint8Array }[] = [{ ref: known, bytes: primary }];
          let complete = true;
          for (const ref of refs) {
            sum += ref.bytes;
            if (sum > owned.maxBytes) throw new ResourceError('RESOURCE_BUSY', 'action outputs exceed handoff budget');
            const bytes = await load(ref);
            if (!bytes) {
              complete = false;
              break;
            }
            outputs.push({ ref, bytes });
          }
          if (complete) {
            this.options.source.assert(action.generation);
            owned.releaseHandoff();
            for (const output of outputs) {
              this.handoff.put(output.ref.digest, this.retainBytes(output.ref, output.bytes));
            }
            const held = this.hold(outputs.map((output) => output.ref));
            try {
              await this.options.index.set(action.actionKey, known);
              this.options.source.assert(action.generation);
              this.metrics.actionHit++;
              return held;
            } catch (error) {
              held.release();
              throw error;
            }
          }
        }
      }
      this.metrics.actionMiss++;
      this.metrics.generation++;
      const generated = await action.generate(this.controller.signal);
      this.controller.signal.throwIfAborted();
      const bytes = generated instanceof Uint8Array ? generated : generated.bytes;
      const related = generated instanceof Uint8Array ? [] : generated.related;
      if (
        related.length + 1 > owned.maxArtifacts ||
        related.reduce((sum, item) => sum + item.bytes.byteLength, bytes.byteLength) > action.maxBytes
      )
        throw new ResourceError('RESOURCE_BUSY', 'generator outputs exceeded declared byte budget');
      if (bytes.byteLength > action.maxBytes)
        throw new ResourceError('RESOURCE_BUSY', 'generator exceeded declared output budget');
      this.options.source.assert(action.generation);
      const ref = artifactRef(bytes, action.mediaType, action.format);
      if (known && (known.digest !== ref.digest || known.bytes !== ref.bytes))
        throw new ResourceError('RESOURCE_INTEGRITY_FAILED', 'generator changed bytes for the same action');
      const outputs = related.map((item) => ({
        ref: artifactRef(item.bytes, item.mediaType, item.format),
        bytes: item.bytes,
      }));
      owned.releaseHandoff();
      this.handoff.put(ref.digest, this.retainBytes(ref, bytes));
      for (const output of outputs) {
        this.handoff.put(output.ref.digest, this.retainBytes(output.ref, output.bytes));
      }
      const held = this.hold([ref, ...outputs.map((output) => output.ref)]);
      try {
        for (const layer of this.options.layers ?? []) {
          for (const output of outputs) await layer.retain(output.ref.digest, output.ref, output.bytes);
          await layer.retain(action.actionKey, ref, bytes);
        }
        this.options.source.assert(action.generation);
        await this.options.index.set(action.actionKey, ref);
        this.options.source.assert(action.generation);
        return held;
      } catch (error) {
        held.release();
        throw error;
      }
    } finally {
      if (!reservation) {
        owned.releaseHandoff();
        owned.releaseWork();
      }
    }
  }
  private retainBytes(ref: ArtifactRef, bytes: Uint8Array): Uint8Array {
    // Generated digests are cold lookups too. Without observing them, a scan
    // never reaches the admission policy's low-benefit sampling window.
    const retained = this.cache.get(ref.digest);
    if (retained) return retained;
    this.cache.set(ref.digest, bytes, bytes.byteLength);
    return bytes;
  }
  open(ref: ArtifactRef): Uint8Array {
    const pin = this.handoff.get(ref.digest);
    const bytes = pin?.bytes ?? this.cache.get(ref.digest);
    if (!bytes)
      throw new ResourceError('RESOURCE_VIEW_EXPIRED', 'resource is no longer retained; resolve the view again', true);
    if (pin) this.metrics.handoffHit++;
    verifyArtifact(ref, bytes);
    return bytes;
  }
  async acquire(ref: ArtifactRef, consumePromise = true): Promise<ArtifactRead> {
    const release = await this.work.waitReserve(ref.bytes, this.options.maxTasks, this.controller.signal);
    try {
      const bytes = this.open(ref);
      let active = true;
      return {
        bytes,
        transfer: (bytes) => {
          this.metrics.apiBodyBytesEnqueued += bytes;
        },
        release: () => {
          if (active) {
            active = false;
            if (consumePromise) this.handoff.consume(ref.digest);
            else this.handoff.releaseUnclaimed(ref.digest);
            release();
          }
        },
      };
    } catch (error) {
      release();
      throw error;
    }
  }
  async ensureOriginal(
    store: AtomicObjectStorage & ConditionalObjectWriter,
    ref: ArtifactRef,
    bytes: Uint8Array,
  ): Promise<void> {
    this.controller.signal.throwIfAborted();
    // Reliable originals never enter any optional cache or eviction inventory.
    const release = this.work.reserve(bytes.byteLength * 2);
    try {
      verifyArtifact(ref, bytes);
      if (await new ContentAddressedStorage(store, store).ensure(ref, bytes)) {
        this.metrics.originalPut++;
        this.metrics.originalUploadedBytes += bytes.byteLength;
      }
    } finally {
      release();
    }
  }
  async readObject(
    reader: ObjectReader,
    key: string,
    ref: ArtifactRef,
    range?: { start: number; end: number },
  ): Promise<ArtifactRead> {
    this.controller.signal.throwIfAborted();
    const length = range ? range.end - range.start + 1 : ref.bytes;
    if (
      range &&
      (!Number.isSafeInteger(range.start) ||
        !Number.isSafeInteger(range.end) ||
        range.start < 0 ||
        range.end < range.start ||
        range.end >= ref.bytes)
    )
      throw new RangeError('resource range out of bounds');
    const release = await this.work.waitReserve(length, this.options.maxTasks, this.controller.signal);
    try {
      const bytes = range
        ? await reader.readRange(key, range.start, length)
        : await reader.readRange(key, 0, ref.bytes + 1);
      if (!bytes || bytes.byteLength !== length)
        throw new ResourceError(
          'RESOURCE_BACKEND_UNAVAILABLE',
          'authoritative resource object is missing or incomplete',
          true,
        );
      if (!range) verifyArtifact(ref, bytes);
      return {
        bytes,
        release,
        transfer: (bytes) => {
          this.metrics.apiBodyBytesEnqueued += bytes;
        },
      };
    } catch (error) {
      release();
      throw error;
    }
  }
  async rememberAction(key: string, ref: ArtifactRef) {
    await this.options.index.set(key, ref);
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.controller.abort(new ResourceError('RESOURCE_BUSY', 'resource service is closing', true));
      this.closing = Promise.all([this.prepares.close(), this.tasks.close()]).then(async () => {
        this.handoff.close();
        this.options.index.close();
        this.cache.resize(0);
        for (const layer of this.options.layers ?? []) await layer.close();
      });
    }
    return this.closing;
  }
}
