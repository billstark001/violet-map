import {
  canonicalJson,
  ResourceError,
  type ArtifactRef,
  type PublicationEntry,
  type PublicationManifest,
  type ResourceSelector,
} from '@violet-map/core/resources';
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
import { type Singleflight } from './singleflight.js';
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
  operations: Singleflight;
  generator: ResourceGenerator;
  sessions: ResourceViewSessions;
  renderRoot: (
    token?: SnapshotToken,
    previous?: PublicationManifest,
  ) => Promise<{ digest: string; entries: PublicationEntry[] }>;
  rootEntries: () => PublicationEntry[];
}

/** Builds and verifies complete closures before committing an authoritative head. */
export class ResourcePublisher {
  private closed = false;
  private publicationTimer?: ReturnType<typeof setTimeout>;
  private dirtySince = 0;
  private previousPublication?: PublicationManifest;
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
  }
  schedule() {
    if (this.closed || this.state.requiresSourceSnapshot || !this.options.config.resources.roles.includes('publish'))
      return;
    this.dirtySince ||= Date.now();
    if (this.publicationTimer) clearTimeout(this.publicationTimer);
    const options = this.options.config.resources.publication;
    const delay = Math.max(0, Math.min(options.debounceMs, options.maxDelayMs - (Date.now() - this.dirtySince)));
    this.publicationTimer = setTimeout(() => {
      this.publicationTimer = undefined;
      this.dirtySince = 0;
      if (this.state.requiresSourceSnapshot) return;
      void this.publish().catch(async (error) => {
        this.state.publication = 'failed';
        this.state.error = error instanceof ResourceError ? error.code : 'RESOURCE_BACKEND_UNAVAILABLE';
        try {
          await this.options.store?.pending('failed', this.state.error, this.state.requiresSourceSnapshot);
        } catch {
          this.state.error = 'RESOURCE_BACKEND_UNAVAILABLE';
        }
      });
    }, delay);
    this.publicationTimer.unref();
  }

  async resume() {
    if (!this.options.config.resources.roles.includes('publish') || !this.options.store) return;
    // Reconcile even if a crash happened after a business head commit but
    // before its pending marker. A stable closure remains a zero-write no-op.
    const pending = await this.options.store.publicationState();
    this.state.requiresSourceSnapshot = pending?.requiresSourceSnapshot === true;
    if (pending || (await this.options.store.head())) {
      this.state.publication = 'pending';
      this.schedule();
    }
  }

  private async publishEntry(entry: PublicationEntry, token: SnapshotToken) {
    if (!this.options.target) throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'publication target is not configured');
    let restored: PublicationEntry | null | undefined;
    try {
      if (
        entry.selector.kind !== 'overlay-media' &&
        (!this.repo().lease(entry.artifact) || (entry.image && !this.repo().lease(entry.image)))
      ) {
        restored = await this.options.generator.generate(entry.selector, this.options.coordinator.generation, token);
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
          await this.options.target.ensure(entry.artifact, lease.bytes);
          await this.options.target.verify(entry.artifact);
        } finally {
          lease.release();
        }
        return;
      }
      for (const ref of refs) {
        const lease = await this.repo().acquire(ref, false);
        try {
          await this.options.target.ensure(ref, lease.bytes);
          await this.options.target.verify(ref);
        } finally {
          lease.release();
        }
      }
    } finally {
      this.options.generator.release(entry);
      if (restored) this.options.generator.release(restored);
    }
  }

  async publish(
    expectedHead?: string | null,
    prepared?: PublicationManifest,
  ): Promise<import('@violet-map/core/resources').PublicationHead> {
    const expectedManifest =
      prepared === undefined ? undefined : sha256(canonicalJson(parsePublicationManifest(prepared)));
    if (expectedManifest && sha256(canonicalJson(await this.prepare())) !== expectedManifest) {
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
    )) as import('@violet-map/core/resources').PublicationHead;
  }

  async prepare(): Promise<PublicationManifest> {
    return (await this.buildPublication(undefined, true)) as PublicationManifest;
  }

  private async buildPublication(
    expectedHead: string | null | undefined,
    prepareOnly: boolean,
    expectedManifest?: string,
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
    return this.options.sourceGate.write((token) =>
      this.options.operations.run('publication', async () => {
        const started = Date.now();
        this.state.publication = 'pending';
        this.state.error = undefined;
        const previous = await this.options.store!.head();
        const expected = expectedHead === undefined ? (previous?.publicationId ?? null) : expectedHead;
        if ((previous?.publicationId ?? null) !== expected)
          throw new ResourceError('PUBLICATION_CONFLICT', 'expected publication head changed');
        this.previousPublication = previous ? await this.options.store!.manifest(previous) : undefined;
        const generation = this.options.coordinator.generation;
        try {
          const root = await this.options.renderRoot(token, this.previousPublication);
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
            else await this.publishEntry(entry, token);
          }
          for (const id of await this.options.dynamic!.assets.textureIds()) {
            if (manifest.entries.some((e) => e.selector.kind === 'texture' && e.selector.id === id)) continue;
            const selector: ResourceSelector = { kind: 'texture', id };
            const old = this.previousPublication?.entries.find(
              (e) => selectorKey(e.selector) === selectorKey(selector),
            );
            if (old) await this.repo().rememberAction(old.actionKey, old.artifact);
            const entry = await this.options.generator.generate(selector, generation, token);
            if (entry) {
              if (prepareOnly) this.options.generator.discard(entry);
              else await this.publishEntry(entry, token);
              track(entry);
              manifest.entries.push(entry);
            }
          }
          for (const world of worlds) {
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
                    else await this.publishEntry(entry, token);
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
                  else await this.publishEntry(entry, token);
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
                  if (!prepareOnly) await this.publishEntry(entry, token);
                  track(entry);
                  manifest.entries.push(entry);
                }
              }
          manifest.entries.sort((a, b) => selectorKey(a.selector).localeCompare(selectorKey(b.selector)));
          manifest.overlays.sort((a, b) => a.mapId.localeCompare(b.mapId) || a.dimension.localeCompare(b.dimension));
          if (prepareOnly) {
            this.state.publication = 'pending';
            return manifest;
          }
          if (expectedManifest && sha256(canonicalJson(manifest)) !== expectedManifest)
            throw new ResourceError('SOURCE_SNAPSHOT_CHANGED', 'source changed after prepared publication validation');
          const verify = async () => {
            for (const entry of manifest.entries)
              for (const ref of [entry.artifact, ...(entry.image ? [entry.image] : [])])
                if (!(await this.options.target!.exists(ref)))
                  throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'publication closure contains a missing object');
            for (const region of manifest.regions) {
              const page = await this.options.store!.page(region.artifact);
              for (const entry of page.chunks)
                if (!(await this.options.target!.exists(entry.artifact)))
                  throw new ResourceError(
                    'RESOURCE_NOT_PUBLISHED',
                    'publication region closure contains a missing object',
                  );
            }
          };
          const head = await this.options.store!.commit(
            manifest,
            expected,
            async () => {
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
          throw error;
        } finally {
          this.previousPublication = undefined;
          for (const entry of this.options.rootEntries()) this.options.generator.discard(entry);
        }
      }),
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
