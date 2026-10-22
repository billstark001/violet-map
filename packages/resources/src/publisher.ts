import {
  canonicalJson,
  parseResourceSelector,
  ResourceError,
  type ArtifactRef,
  type PublicationEntry,
  type PublicationManifest,
  type ResourceSelector,
  type ResourceViewHead,
  type ResolvedResource,
} from '@violet-map/core/resources';
import { randomUUID } from 'node:crypto';
import { isWorldName } from '@violet-map/core/domain';
import { sha256 } from '@violet-map/storage';
import type { ResourceEngineConfig, ResourceEngineMounts, DynamicSources, ContentSource } from './engineTypes.js';
import type { InvalidationCoordinator } from './invalidation.js';
import type { BlobRepository } from './blobRepository.js';
import { ByteBudget } from './budget.js';
import { collectPublicationGarbage } from './gc.js';
import { parsePublicationManifest, regionPage, selectorKey, type PublicationStore } from './publication.js';
import type { PublicTarget } from './publicTarget.js';
import type { ResourceGenerator } from './generator.js';
import type { ResourceViewSessions } from './viewSessions.js';
import { Singleflight } from './singleflight.js';
import { type SnapshotGate, type SnapshotToken } from './snapshotGate.js';
import { resourceJsonBytes, projectionKey } from './engineSupport.js';

interface ResourcePublisherOptions {
  config: ResourceEngineConfig;
  mounts: ResourceEngineMounts;
  coordinator: InvalidationCoordinator;
  repository: BlobRepository | undefined;
  store: PublicationStore | undefined;
  target: PublicTarget | undefined;
  dynamic: DynamicSources | undefined;
  content: ContentSource | undefined;
  sourceGate: SnapshotGate;
  generator: ResourceGenerator;
  sessions: ResourceViewSessions;
  renderRoot: (
    token?: SnapshotToken,
    previous?: PublicationManifest,
  ) => Promise<{ digest: string; entries: PublicationEntry[] }>;
  rootEntries: () => PublicationEntry[];
  publicResult: (
    selectors: ResourceSelector[],
    world?: string,
  ) => Promise<{
    head: ResourceViewHead;
    resources: ResolvedResource[];
  }>;
}

export interface PublicationTask {
  id: string;
  state: 'pending' | 'ready' | 'failed';
  startedAt: number;
  finishedAt?: number;
  result?: { head: ResourceViewHead; resources: ResolvedResource[] };
  error?: { code: string; message: string; retryable: boolean };
}

/** Builds and verifies complete closures before committing an authoritative head. */
export class ResourcePublisher {
  private closed = false;
  private publicationTimer?: ReturnType<typeof setTimeout>;
  private dirtySince = 0;
  private reconciling?: Promise<void>;
  private reconcileAgain = false;
  private buildRevision = 0;
  private previousPublication?: PublicationManifest;
  private readonly builds = new Singleflight(1);
  private task?: { intent: string; value: PublicationTask; controller: AbortController; done: Promise<void> };
  readonly state = {
    publication: 'ready' as 'ready' | 'pending' | 'failed',
    error: undefined as string | undefined,
    sourceObservedAt: 0,
    publicationLagMs: 0,
    requiresSourceSnapshot: false,
  };
  constructor(private readonly options: ResourcePublisherOptions) {}
  private repo() {
    if (!this.options.repository)
      throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'dynamic resource generation is disabled');
    return this.options.repository;
  }
  close() {
    this.closed = true;
    if (this.publicationTimer) clearTimeout(this.publicationTimer);
    this.task?.controller.abort(new ResourceError('RESOURCE_BUSY', 'publisher is closing', true));
    void this.builds.close();
  }
  async drain() {
    await this.task?.done;
    if (this.closed) await this.builds.close();
    await this.reconciling;
  }
  taskStatus(id?: string): PublicationTask | null {
    if (this.task?.value.finishedAt && Date.now() - this.task.value.finishedAt >= 86400000) this.task = undefined;
    if (id && this.task?.value.id !== id)
      throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'publication task is no longer retained');
    return this.task ? structuredClone(this.task.value) : null;
  }
  /** One server-owned operation; disconnecting a polling client cannot cancel a publication. */
  start(expectedHead: string | null, selectors: ResourceSelector[] = [], world?: string): PublicationTask {
    this.taskStatus();
    if (this.closed) throw new ResourceError('RESOURCE_BUSY', 'publisher is closing', true);
    if (
      this.options.config.resources.delivery.mode !== 'public' ||
      !this.options.config.resources.roles.includes('publish')
    )
      throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'online publication requires public delivery and publish role');
    if (expectedHead !== null && !/^[a-f0-9]{64}$/.test(expectedHead)) throw new TypeError('invalid expectedHead');
    if (selectors.length > 128) throw new RangeError('at most 128 resource selectors are allowed');
    if (world !== undefined && !isWorldName(world)) throw new TypeError('invalid world');
    selectors = selectors.map(parseResourceSelector);
    const intent = canonicalJson({ expectedHead, selectors, world: world ?? null });
    if (intent.length * 6 + 4096 > this.options.config.resources.cache.metadataBytes / 16)
      throw new ResourceError('RESOURCE_BUSY', 'publication task exceeds metadata budget');
    if (this.task?.intent === intent && this.task.value.state !== 'failed') return this.taskStatus()!;
    if (this.task?.value.state === 'pending')
      throw new ResourceError('RESOURCE_BUSY', 'another online publication is running', true);
    const controller = new AbortController();
    const value: PublicationTask = { id: randomUUID(), state: 'pending', startedAt: Date.now() };
    const owned = { intent, value, controller, done: Promise.resolve() };
    this.task = owned;
    owned.done = Promise.resolve().then(async () => {
      try {
        const committed = await this.publish(expectedHead, undefined, controller.signal);
        controller.signal.throwIfAborted();
        const result = await this.options.publicResult(selectors, world);
        controller.signal.throwIfAborted();
        if (result.head.mode !== 'public' || result.head.publicationId !== committed.publicationId)
          throw new ResourceError('PUBLICATION_CONFLICT', 'publication changed before returning public links', true);
        if (
          resourceJsonBytes(result).byteLength * 6 + intent.length * 2 + 4096 >
          this.options.config.resources.cache.metadataBytes / 16
        )
          throw new ResourceError('RESOURCE_BUSY', 'publication result exceeds metadata budget');
        value.result = result;
        value.state = 'ready';
      } catch (error) {
        value.state = 'failed';
        value.error =
          error instanceof ResourceError
            ? { code: error.code, message: error.message, retryable: error.retryable }
            : { code: 'RESOURCE_BACKEND_UNAVAILABLE', message: 'online publication failed', retryable: true };
      } finally {
        value.finishedAt = Date.now();
      }
    });
    return this.taskStatus()!;
  }
  schedule() {
    if (this.closed || this.state.requiresSourceSnapshot || !this.options.config.resources.roles.includes('publish'))
      return;
    this.dirtySince ||= Date.now();
    if (this.reconciling) {
      this.reconcileAgain = true;
      return;
    }
    if (this.publicationTimer) clearTimeout(this.publicationTimer);
    const options = this.options.config.resources.publication;
    const delay = Math.max(0, Math.min(options.debounceMs, options.maxDelayMs - (Date.now() - this.dirtySince)));
    this.publicationTimer = setTimeout(() => {
      this.publicationTimer = undefined;
      if (this.state.requiresSourceSnapshot) return;
      const work = this.reconcile();
      this.reconciling = work;
      const finish = () => {
        this.reconciling = undefined;
        if (this.reconcileAgain) {
          this.reconcileAgain = false;
          this.schedule();
        }
      };
      void work.then(finish, finish);
    }, delay);
    this.publicationTimer.unref();
  }
  private async reconcile() {
    let before = this.buildRevision;
    try {
      // A busy foreground prepare/publication is transient coordination, not
      // a failed business publication. Wait without holding another task slot.
      while (this.builds.size) await this.builds.drain();
      if (this.closed || this.state.requiresSourceSnapshot) return;
      this.dirtySince = 0;
      this.reconcileAgain = false;
      before = this.buildRevision;
      await this.publish();
    } catch (error) {
      // Admitted failures are recorded inside their snapshot. A later build or
      // source mutation owns the state now; never overwrite it from this tail.
      if (this.closed || this.state.requiresSourceSnapshot || this.buildRevision !== before) return;
      this.state.publication = 'failed';
      this.state.error = error instanceof ResourceError ? error.code : 'RESOURCE_BACKEND_UNAVAILABLE';
    }
  }

  async resume() {
    if (!this.options.config.resources.roles.includes('publish') || !this.options.store) return;
    // Reconcile even if a crash happened after a business head commit but
    // before its pending marker. A stable closure remains a zero-write no-op.
    const pending = await this.options.store.publicationState();
    this.state.requiresSourceSnapshot = pending?.requiresSourceSnapshot === true;
    const head = await this.options.store.head();
    if (pending || head) {
      this.state.publication = 'pending';
      this.schedule();
    } else if (this.options.config.resources.publication.warmup === 'startup') {
      this.start(null);
    }
  }

  private async publishEntry(entry: PublicationEntry, token: SnapshotToken, signal: AbortSignal) {
    if (!this.options.target) throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'publication target is not configured');
    let restored: PublicationEntry | null | undefined;
    try {
      signal.throwIfAborted();
      if (
        entry.selector.kind !== 'overlay-media' &&
        (!this.repo().lease(entry.artifact) || (entry.image && !this.repo().lease(entry.image)))
      ) {
        restored = await this.options.generator.generate(
          entry.selector,
          this.options.coordinator.generation,
          token,
          signal,
        );
        if (
          !restored ||
          restored.artifact.digest !== entry.artifact.digest ||
          restored.image?.digest !== entry.image?.digest
        )
          throw new ResourceError('RESOURCE_INTEGRITY_FAILED', 'fixed publication action changed its output');
      }
      const refs = [entry.artifact, ...(entry.image ? [entry.image] : [])];
      if (entry.selector.kind === 'overlay-media') {
        const s = entry.selector;
        const media = await this.options.content!.openPublicMedia(s.mapId, s.dimension, s.assetId, s.versionId);
        const lease = await media.read();
        try {
          signal.throwIfAborted();
          await this.options.target.ensure(entry.artifact, lease.bytes);
        } finally {
          lease.release();
        }
        signal.throwIfAborted();
        await this.options.target.verify(entry.artifact);
        return;
      }
      for (const ref of refs) {
        const lease = await this.repo().acquire(ref, false, signal);
        try {
          await this.options.target.ensure(ref, lease.bytes);
        } finally {
          lease.release();
        }
        signal.throwIfAborted();
        await this.options.target.verify(ref);
      }
    } finally {
      this.options.generator.release(entry);
      if (restored) this.options.generator.release(restored);
    }
  }

  async publish(
    expectedHead?: string | null,
    prepared?: PublicationManifest,
    signal?: AbortSignal,
  ): Promise<import('@violet-map/core/resources').PublicationHead> {
    signal?.throwIfAborted();
    const expectedManifest =
      prepared === undefined ? undefined : sha256(canonicalJson(parsePublicationManifest(prepared)));
    if (
      expectedManifest &&
      sha256(canonicalJson(await this.buildPublication(undefined, true, undefined, signal))) !== expectedManifest
    ) {
      this.state.publication = 'failed';
      this.state.error = 'SOURCE_SNAPSHOT_CHANGED';
      throw new ResourceError(
        'SOURCE_SNAPSHOT_CHANGED',
        'current source differs from the reviewed prepared publication',
      );
    }
    return (await this.buildPublication(
      expectedHead,
      false,
      expectedManifest,
      signal,
    )) as import('@violet-map/core/resources').PublicationHead;
  }

  async prepare(): Promise<PublicationManifest> {
    return (await this.buildPublication(undefined, true)) as PublicationManifest;
  }

  private async buildPublication(
    expectedHead: string | null | undefined,
    prepareOnly: boolean,
    expectedManifest?: string,
    signal?: AbortSignal,
  ) {
    if (
      !this.options.config.resources.roles.includes('publish') ||
      !this.options.store ||
      !this.options.target ||
      !this.options.dynamic
    )
      throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'publish role is disabled');
    if (this.options.config.resources.source.consistency !== 'snapshot')
      throw new ResourceError('SOURCE_SNAPSHOT_CHANGED', 'publications require a controlled snapshot source');
    const intent = canonicalJson({
      expectedHead: expectedHead ?? null,
      automatic: expectedHead === undefined,
      prepareOnly,
      expectedManifest: expectedManifest ?? null,
    });
    return this.builds.run(
      'publication:' + intent,
      (taskSignal) =>
        this.options.sourceGate.write(async (token) => {
          if (!prepareOnly && expectedHead === undefined && this.state.requiresSourceSnapshot)
            throw new ResourceError(
              'SOURCE_SNAPSHOT_CHANGED',
              'automatic publication requires an explicit source snapshot',
            );
          this.buildRevision++;
          const started = Date.now();
          this.state.publication = 'pending';
          this.state.error = undefined;
          try {
            const previous = await this.options.store!.head();
            const expected = expectedHead === undefined ? (previous?.publicationId ?? null) : expectedHead;
            if ((previous?.publicationId ?? null) !== expected)
              throw new ResourceError('PUBLICATION_CONFLICT', 'expected publication head changed');
            this.previousPublication = previous ? await this.options.store!.manifest(previous) : undefined;
            const generation = this.options.coordinator.generation;
            taskSignal.throwIfAborted();
            const root = await this.options.renderRoot(token, this.previousPublication);
            taskSignal.throwIfAborted();
            const worlds = await this.options.dynamic!.worldStore.listWorlds();
            const manifest: PublicationManifest = {
              schemaVersion: 1,
              sourceScope: await this.options.sessions.sourceScope(),
              archiveIds: {},
              sourceScopes: {},
              renderRoot: root.digest,
              worlds,
              entries: [...root.entries],
              regions: [],
              coverage: {},
              topMaps: {},
              overlays: [],
            };
            const metadata = new ByteBudget(Math.floor(this.options.config.resources.cache.metadataBytes / 4));
            const track = (value: unknown) => metadata.reserve(256 + resourceJsonBytes(value).byteLength * 4);
            track(manifest);
            for (const entry of root.entries) {
              if (prepareOnly) this.options.generator.discard(entry);
              else await this.publishEntry(entry, token, taskSignal);
            }
            for (const id of await this.options.dynamic!.assets.textureIds()) {
              taskSignal.throwIfAborted();
              if (manifest.entries.some((e) => e.selector.kind === 'texture' && e.selector.id === id)) continue;
              const selector: ResourceSelector = { kind: 'texture', id };
              const old = this.previousPublication?.entries.find(
                (e) => selectorKey(e.selector) === selectorKey(selector),
              );
              if (old) await this.repo().rememberAction(old.actionKey, old.artifact);
              const entry = await this.options.generator.generate(selector, generation, token);
              if (entry) {
                if (prepareOnly) this.options.generator.discard(entry);
                else await this.publishEntry(entry, token, taskSignal);
                track(entry);
                manifest.entries.push(entry);
              }
            }
            for (const world of worlds) {
              taskSignal.throwIfAborted();
              manifest.sourceScopes[world.id] = await this.options.sessions.sourceScope(world.id);
              const identity = await this.options.mounts.worlds!.read(`${world.id}/.violet-map/identity.json`);
              if (identity) {
                const value = JSON.parse(new TextDecoder().decode(identity));
                if (value.schema !== 1 || typeof value.id !== 'string')
                  throw new ResourceError('SOURCE_REVISION_UNAVAILABLE', 'invalid archive identity');
                manifest.archiveIds[world.id] = value.id;
              }
              for (const dimension of world.dimensions) {
                const coverage = await this.options.dynamic!.worldStore.listChunkSourceCoverage(world.id, dimension);
                if (resourceJsonBytes(coverage).byteLength * 4 > this.options.config.resources.cache.metadataBytes / 4)
                  throw new ResourceError('RESOURCE_BUSY', 'world coverage exceeds publication metadata budget');
                manifest.coverage[projectionKey(world.id, dimension)] = coverage;
                track(coverage);
                const coordinates = new Map<string, { rx: number; rz: number }>();
                for (const r of coverage.regions) coordinates.set(`${r.x},${r.z}`, { rx: r.x, rz: r.z });
                for (const c of coverage.chunks) {
                  const rx = Math.floor(c.cx / 32),
                    rz = Math.floor(c.cz / 32);
                  coordinates.set(`${rx},${rz}`, { rx, rz });
                }
                for (const { rx, rz } of [...coordinates.values()].sort((a, b) => a.rx - b.rx || a.rz - b.rz)) {
                  const oldRegion = this.previousPublication?.regions.find(
                    (r) => r.world === world.id && r.dimension === dimension && r.rx === rx && r.rz === rz,
                  );
                  const oldPage = oldRegion ? await this.options.store!.page(oldRegion.artifact) : undefined;
                  const mask = coverage.regions.find((r) => r.x === rx && r.z === rz)?.mask;
                  const bits = mask ? new Uint8Array(Buffer.from(mask, 'base64')) : new Uint8Array(128);
                  if (bits.byteLength !== 128)
                    throw new ResourceError('SOURCE_REVISION_UNAVAILABLE', 'invalid region coverage mask');
                  const selected = new Set<number>();
                  for (let i = 0; i < 1024; i++) if (bits[i >> 3] & (1 << (i & 7))) selected.add(i);
                  for (const c of coverage.chunks)
                    if (Math.floor(c.cx / 32) === rx && Math.floor(c.cz / 32) === rz)
                      selected.add((c.cx & 31) + (c.cz & 31) * 32);
                  const chunks: PublicationEntry[] = [];
                  for (const i of [...selected].sort((a, b) => a - b)) {
                    taskSignal.throwIfAborted();
                    const selector: ResourceSelector = {
                      kind: 'chunk',
                      world: world.id,
                      dimension,
                      cx: rx * 32 + (i & 31),
                      cz: rz * 32 + (i >> 5),
                    };
                    const old = oldPage?.chunks.find((e) => selectorKey(e.selector) === selectorKey(selector));
                    if (old) await this.repo().rememberAction(old.actionKey, old.artifact);
                    const entry = await this.options.generator.generate(selector, generation, token);
                    if (entry) {
                      if (prepareOnly) this.options.generator.discard(entry);
                      else await this.publishEntry(entry, token, taskSignal);
                      chunks.push(entry);
                    }
                  }
                  const page = regionPage(world.id, dimension, rx, rz, chunks);
                  if (!prepareOnly) await this.options.store!.ensureIndex(page.artifact, page.bytes);
                  const region = { world: world.id, dimension, rx, rz, artifact: page.artifact };
                  track(region);
                  manifest.regions.push(region);
                }
                const topData = (await this.options.dynamic!.topMap.getTopMapManifest(world.id))?.dimensions[dimension];
                const topMap = topData ? { ...topData, world: world.id, dimension } : null;
                if (topMap) {
                  track(topMap);
                  manifest.topMaps[projectionKey(world.id, dimension)] = topMap;
                  for (const region of topMap.topMap?.regions ?? []) {
                    taskSignal.throwIfAborted();
                    const selector: ResourceSelector = {
                      kind: 'top-map-tile',
                      world: world.id,
                      dimension,
                      rx: region.x,
                      rz: region.z,
                    };
                    const old = this.previousPublication?.entries.find(
                      (e) => selectorKey(e.selector) === selectorKey(selector),
                    );
                    if (old) await this.repo().rememberAction(old.actionKey, old.artifact);
                    const entry = await this.options.generator.generate(selector, generation, token);
                    if (!entry) throw new ResourceError('TOPMAP_REBAKE_REQUIRED', 'baked tile is missing');
                    if (prepareOnly) this.options.generator.discard(entry);
                    else await this.publishEntry(entry, token, taskSignal);
                    track(entry);
                    manifest.entries.push(entry);
                  }
                }
              }
            }
            if (this.options.content)
              for (const map of await this.options.content.listMaps())
                for (const dimension of [
                  ...new Set(map.bindings.filter((b) => b.enabled).map((b) => b.dimension)),
                ].sort()) {
                  const snapshot = await this.options.content.snapshot(map.mapId, dimension);
                  track(snapshot);
                  manifest.overlays.push(snapshot);
                  const bindingWorld = worlds.find((w) => w.id === map.worldKey);
                  if (bindingWorld) bindingWorld.mapIds = [...new Set([...(bindingWorld.mapIds ?? []), map.mapId])];
                  for (const version of snapshot.media) {
                    taskSignal.throwIfAborted();
                    const entry = await this.options.generator.generate(
                      {
                        kind: 'overlay-media',
                        mapId: map.mapId,
                        dimension,
                        assetId: version.assetId,
                        versionId: version.versionId,
                      },
                      generation,
                      token,
                    );
                    if (!entry) throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'bound media is missing');
                    if (!prepareOnly) await this.publishEntry(entry, token, taskSignal);
                    track(entry);
                    manifest.entries.push(entry);
                  }
                }
            manifest.entries.sort((a, b) => selectorKey(a.selector).localeCompare(selectorKey(b.selector)));
            manifest.overlays.sort((a, b) => a.mapId.localeCompare(b.mapId) || a.dimension.localeCompare(b.dimension));
            if (prepareOnly) {
              taskSignal.throwIfAborted();
              this.state.publication = 'pending';
              return manifest;
            }
            if (expectedManifest && sha256(canonicalJson(manifest)) !== expectedManifest)
              throw new ResourceError(
                'SOURCE_SNAPSHOT_CHANGED',
                'source changed after prepared publication validation',
              );
            const verify = async () => {
              taskSignal.throwIfAborted();
              for (const entry of manifest.entries)
                for (const ref of [entry.artifact, ...(entry.image ? [entry.image] : [])]) {
                  taskSignal.throwIfAborted();
                  if (!(await this.options.target!.exists(ref)))
                    throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'publication closure contains a missing object');
                }
              for (const region of manifest.regions) {
                taskSignal.throwIfAborted();
                const page = await this.options.store!.page(region.artifact);
                for (const entry of page.chunks) {
                  taskSignal.throwIfAborted();
                  if (!(await this.options.target!.exists(entry.artifact)))
                    throw new ResourceError(
                      'RESOURCE_NOT_PUBLISHED',
                      'publication region closure contains a missing object',
                    );
                }
              }
            };
            const head = await this.options.store!.commit(
              manifest,
              expected,
              async () => {
                taskSignal.throwIfAborted();
                this.options.coordinator.assert(generation);
              },
              verify,
            );
            try {
              await this.options.store!.clearPending();
            } catch {
              this.state.error = 'RESOURCE_BACKEND_UNAVAILABLE';
            }
            this.state.publication = 'ready';
            this.state.requiresSourceSnapshot = false;
            this.state.publicationLagMs = Date.now() - started;
            return head;
          } catch (error) {
            this.state.publication = 'failed';
            this.state.error = error instanceof ResourceError ? error.code : 'RESOURCE_BACKEND_UNAVAILABLE';
            if (!prepareOnly && expectedHead === undefined && !this.closed) {
              try {
                await this.options.store!.pending('failed', this.state.error, this.state.requiresSourceSnapshot);
              } catch {
                this.state.error = 'RESOURCE_BACKEND_UNAVAILABLE';
              }
            }
            throw error;
          } finally {
            this.previousPublication = undefined;
            for (const entry of this.options.rootEntries()) this.options.generator.discard(entry);
          }
        }, taskSignal),
      signal,
    );
  }

  private async verifyManifest(manifest: PublicationManifest) {
    if (!this.options.store || !this.options.target)
      throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'publication target is not configured');
    let objects = 0;
    const verify = async (ref: ArtifactRef) => {
      await this.options.target!.verify(ref);
      objects++;
    };
    for (const entry of manifest.entries) {
      await verify(entry.artifact);
      if (entry.image) await verify(entry.image);
    }
    for (const region of manifest.regions)
      for (const entry of (await this.options.store.page(region.artifact)).chunks) await verify(entry.artifact);
    return { objects };
  }

  async verify() {
    const head = await this.options.store?.head();
    if (!head) throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'no publication exists');
    return {
      publicationId: head.publicationId,
      ...(await this.verifyManifest(await this.options.store!.manifest(head))),
    };
  }

  async reindex() {
    const head = await this.options.store?.head();
    if (!head) return 0;
    if (!this.options.repository)
      throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'select an explicit action index to reindex');
    const manifest = await this.options.store!.manifest(head);
    let actions = 0;
    const record = async (entry: PublicationEntry) => {
      if (!(await this.options.target?.exists(entry.artifact)))
        throw new ResourceError('RESOURCE_BACKEND_UNAVAILABLE', 'reindex requires the complete authoritative closure');
      await this.options.repository!.rememberAction(entry.actionKey, entry.artifact);
      actions++;
    };
    for (const entry of manifest.entries) await record(entry);
    for (const region of manifest.regions)
      for (const entry of (await this.options.store!.page(region.artifact)).chunks) await record(entry);
    return actions;
  }

  async recover(quiesced: boolean) {
    if (!quiesced) throw new TypeError('recovery requires explicit confirmation that all other writers are stopped');
    if (!this.options.store || !this.options.config.resources.roles.includes('publish'))
      throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'publish role is disabled');
    return this.options.sourceGate.write(async () => {
      await this.options.store!.recoverQuiesced();
      return this.options.store!.recoverPrepared(async (manifest) => {
        await this.verifyManifest(manifest);
      });
    });
  }

  async gc() {
    if (!this.options.store || !this.options.target || !this.options.config.resources.roles.includes('publish'))
      throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'publish role is disabled');
    return this.options.sourceGate.write(() =>
      collectPublicationGarbage(this.options.store!, this.options.target!, {
        metadataBytes: this.options.config.resources.cache.metadataBytes,
        retainedMs: this.options.config.resources.publication.retainedMs,
      }),
    );
  }
}
