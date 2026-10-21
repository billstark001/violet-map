import type { ResourceEngineConfig, ResourceEngineMounts, DynamicSources, ContentSource } from './engineTypes.js';
import { resourceJsonBytes, projectionKey } from './engineSupport.js';
import { ResourceGenerator } from './generator.js';
import { ResourceViewSessions, type View } from './viewSessions.js';
import { ResourcePublisher } from './publisher.js';
import { LruCache } from '@violet-map/core/cache';
import type {
  AtlasDocument,
  ChunkCoverage,
  TextureAtlasManifest,
  TopMapDimensionManifest,
  WorldCapabilities,
  WorldInfo,
} from '@violet-map/core/contracts';
import type { OverlayManifest } from '@violet-map/core/overlays';
import {
  canonicalJson,
  parseResourceSelector,
  ResourceError,
  type ArtifactRef,
  type PublicationEntry,
  type PublicationManifest,
  type ResolvedResource,
  type ResourceKind,
  type ResourceSelector,
  type ResourceViewHead,
} from '@violet-map/core/resources';
import { ContentAddressedStorage, publicObjectKey, sha256 } from '@violet-map/storage';
import { createHash } from 'node:crypto';
import type { BlobRepository } from './blobRepository.js';
import { ByteBudget } from './budget.js';
import { ResourceDelivery } from './delivery.js';
import type { InvalidationCoordinator } from './invalidation.js';
import { selectorKey, type PublicationStore } from './publication.js';
import type { PublicTarget } from './publicTarget.js';
import { Singleflight } from './singleflight.js';
import { SnapshotGate, type SnapshotToken } from './snapshotGate.js';
import { BoundedSource } from './sourceSnapshot.js';

const family = (s: ResourceSelector): ResourceKind => (s.kind === 'atlas' ? 'atlas-manifest' : s.kind);

export class ResourceEngine {
  private readonly generator: ResourceGenerator;
  private readonly sessions: ResourceViewSessions;
  readonly publication: ResourcePublisher;
  private bounded?: BoundedSource;
  private observationTimer?: ReturnType<typeof setTimeout>;
  private readonly observationController = new AbortController();
  private closed = false;
  private readonly operations: Singleflight;
  private readonly members = new Map<string, { entry?: PublicationEntry; validUntil: number; release(): void }>();
  private readonly memberMetadata: ByteBudget;
  private readonly pages: LruCache<string, import('@violet-map/core/resources').RegionResourcePage>;
  private readonly sourceGate = new SnapshotGate();
  private root?: { generation: number; digest: string; entries: PublicationEntry[] };
  private readonly delivery: ResourceDelivery;
  constructor(
    readonly config: ResourceEngineConfig,
    readonly mounts: ResourceEngineMounts,
    readonly coordinator: InvalidationCoordinator,
    readonly repository: BlobRepository | undefined,
    readonly store: PublicationStore | undefined,
    readonly target: PublicTarget | undefined,
    private readonly dynamic: DynamicSources | undefined,
    private readonly content: ContentSource | undefined,
  ) {
    // Publication and render-root coordination can enclose one admitted generator.
    // Reserve their two slots separately from the repository's actual task limit.
    this.operations = new Singleflight(Math.min(Number.MAX_SAFE_INTEGER, config.resources.work.maxTasks + 2));
    const budget = config.resources.cache.metadataBytes;
    this.memberMetadata = new ByteBudget(Math.floor(budget / 4));
    this.pages = new LruCache({
      maxEntries: 16,
      maxWeight: budget / 4,
      weightOf: (p) => resourceJsonBytes(p).byteLength * 4,
    });
    this.generator = new ResourceGenerator(
      repository,
      dynamic,
      content,
      this.sourceGate,
      this.operations,
      this.memberMetadata,
    );
    this.sessions = new ResourceViewSessions(
      config,
      mounts,
      coordinator,
      store,
      this.sourceGate,
      (token) => this.renderRoot(token),
      (entry) => this.generator.discard(entry),
    );
    this.publication = new ResourcePublisher({
      config,
      mounts,
      coordinator,
      repository,
      store,
      target,
      dynamic,
      content,
      sourceGate: this.sourceGate,
      operations: this.operations,
      generator: this.generator,
      sessions: this.sessions,
      renderRoot: (token, previous) => this.renderRoot(token, previous),
      rootEntries: () => this.root?.entries ?? [],
    });
    if (config.resources.source.consistency === 'bounded' && dynamic)
      this.bounded = new BoundedSource(
        coordinator,
        async () => {
          const release = await this.repo().work.waitReserve(
            128 * 1024 ** 2,
            config.resources.work.maxTasks + 1,
            this.observationController.signal,
          );
          try {
            const hash = createHash('sha256');
            hash.update(await dynamic.assets.sourceRevision());
            hash.update(resourceJsonBytes(await dynamic.gameData.buildBlockInfo()));
            hash.update(resourceJsonBytes(await dynamic.gameData.readBiomes()));
            hash.update(resourceJsonBytes(await dynamic.gameData.readDimensions()));
            const files = await mounts.worlds!.list();
            if (files.length > Math.floor(budget / 1024))
              throw new ResourceError('RESOURCE_BUSY', 'source inventory exceeds metadata budget');
            for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
              this.observationController.signal.throwIfAborted();
              if (
                !/\.(mca|nbt|msgpack)$|\/(level.dat|identity.json|world.json)$|\/top-map\/manifest.json$/.test(
                  file.path,
                )
              )
                continue;
              hash.update(canonicalJson({ key: file.path, bytes: file.size }));
              if (file.etag && !/^W\//i.test(file.etag)) {
                hash.update(canonicalJson({ revision: file.etag }));
                continue;
              }
              for (let offset = 0; offset < file.size; offset += 1024 ** 2) {
                const length = Math.min(1024 ** 2, file.size - offset);
                const bytes = await mounts.worlds!.readRange(file.path, offset, length);
                if (!bytes || bytes.byteLength !== length)
                  throw new ResourceError('SOURCE_SNAPSHOT_CHANGED', 'source changed during observation', true);
                hash.update(bytes);
              }
            }
            const result = hash.digest('hex');
            return result;
          } finally {
            release();
          }
        },
        config.resources.source.revalidateMs,
      );
    this.delivery =
      config.resources.delivery.mode === 'public'
        ? new ResourceDelivery({ mode: 'public', publicBaseUrl: config.resources.delivery.publicBaseUrl! })
        : new ResourceDelivery({ mode: 'server', apiBasePath: '/api/resources' });
  }
  private async observe() {
    if (this.closed) throw new ResourceError('RESOURCE_BUSY', 'resource engine is closed', true);
    if (!this.bounded) return;
    const before = this.coordinator.generation;
    try {
      await this.bounded.validate();
      this.publication.state.sourceObservedAt = this.bounded.sourceObservedAt;
      if (before !== this.coordinator.generation) {
        this.root = undefined;
        this.dynamic!.assets.clearTextureAtlasCache();
        for (const file of await this.mounts.worlds!.list()) this.dynamic!.worldStore.invalidateStoredFile(file.path);
      }
    } finally {
      if (!this.closed && !this.observationTimer) {
        this.observationTimer = setTimeout(() => {
          this.observationTimer = undefined;
          void this.observe().catch((error) => {
            this.publication.state.error = error instanceof ResourceError ? error.code : 'RESOURCE_BACKEND_UNAVAILABLE';
          });
        }, this.config.resources.source.revalidateMs);
        this.observationTimer.unref();
      }
    }
  }

  async close() {
    this.closed = true;
    this.observationController.abort(new ResourceError('RESOURCE_BUSY', 'resource engine is closing', true));
    this.publication.close();
    if (this.observationTimer) clearTimeout(this.observationTimer);
    this.observationTimer = undefined;
    await this.operations.close();
    await this.bounded?.drain().catch((error) => {
      if (error !== this.observationController.signal.reason) throw error;
    });
    for (const value of this.members.values()) value.release();
    this.members.clear();
    this.generator.close();
    this.sessions.close();
  }
  invalidate() {
    this.coordinator.invalidate();
    this.root = undefined;
    this.publication.state.sourceObservedAt = Date.now();
    if (this.config.resources.roles.includes('publish') || this.config.resources.delivery.mode === 'public')
      this.publication.state.publication = 'pending';
  }
  private repo(): BlobRepository {
    if (!this.repository) throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'dynamic resource generation is disabled');
    return this.repository;
  }
  async head(world?: string): Promise<ResourceViewHead> {
    await this.observe();
    return this.sessions.head(world);
  }
  private async renderRoot(token?: SnapshotToken, previous?: PublicationManifest) {
    return this.sourceGate.read((snapshot) => this.renderRootSnapshot(snapshot, previous), token);
  }
  private async renderRootSnapshot(token: SnapshotToken, previous?: PublicationManifest) {
    if (!this.dynamic) throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'dynamic source services are disabled');
    if (this.root?.generation === this.coordinator.generation) return this.root;
    const generation = this.coordinator.generation;
    return this.operations.run('render:' + generation, async () => {
      const selectors: ResourceSelector[] = [
        { kind: 'asset-bundle' },
        { kind: 'game-data', name: 'blocks' },
        { kind: 'game-data', name: 'biomes' },
        { kind: 'game-data', name: 'dimensions' },
        { kind: 'atlas', textureSetId: 'default' },
        { kind: 'texture', id: 'minecraft:colormap/grass' },
        { kind: 'texture', id: 'minecraft:colormap/foliage' },
      ];
      const entries: PublicationEntry[] = [];
      try {
        for (const selector of selectors) {
          const old = previous?.entries.find((e) => selectorKey(e.selector) === selectorKey(selector));
          if (old) await this.repo().rememberAction(old.actionKey, old.artifact);
          const entry = await this.generator.generate(selector, generation, token);
          if (!entry && selector.kind === 'texture') continue;
          if (!entry) throw new ResourceError('RESOURCE_BACKEND_UNAVAILABLE', 'render root resource is missing');
          entries.push(entry);
        }
        this.coordinator.assert(generation);
        const root = { generation, digest: sha256(canonicalJson(entries)), entries };
        this.root = root;
        return root;
      } catch (error) {
        for (const entry of entries) this.generator.discard(entry);
        throw error;
      }
    });
  }
  private async publishedEntry(view: View, selector: ResourceSelector): Promise<PublicationEntry | undefined> {
    const manifest = view.publication!;
    if (selector.kind !== 'chunk')
      return manifest.entries.find((e) => selectorKey(e.selector) === selectorKey(selector));
    const rx = Math.floor(selector.cx / 32),
      rz = Math.floor(selector.cz / 32);
    const region = manifest.regions.find(
      (r) => r.world === selector.world && r.dimension === selector.dimension && r.rx === rx && r.rz === rz,
    );
    if (!region) return undefined;
    let page = this.pages.get(region.artifact.digest);
    if (!page) {
      page = await this.store!.page(region.artifact);
      this.pages.set(region.artifact.digest, page);
    }
    return page.chunks.find((e) => selectorKey(e.selector) === selectorKey(selector));
  }
  private resolved(view: View, entry: PublicationEntry): ResolvedResource {
    if (entry.selector.kind === 'atlas')
      return {
        selector: entry.selector,
        manifest: this.delivery.resolve(
          view.head.viewId,
          'atlas-manifest',
          entry.artifact,
          view.head.mode === 'public',
        ),
        image: this.delivery.resolve(view.head.viewId, 'atlas-image', entry.image!, view.head.mode === 'public'),
      };
    return {
      selector: entry.selector,
      resource: this.delivery.resolve(
        view.head.viewId,
        family(entry.selector),
        entry.artifact,
        view.head.mode === 'public',
      ),
      ...(entry.contentDigest ? { contentDigest: entry.contentDigest } : {}),
      ...(entry.terrainDigest ? { terrainDigest: entry.terrainDigest } : {}),
      ...(entry.entityDigest ? { entityDigest: entry.entityDigest } : {}),
    };
  }
  private reserveMember(key: string, selector: ResourceSelector) {
    const existing = this.members.get(key);
    if (existing) {
      existing.validUntil = Date.now() + this.config.resources.work.handoffMs;
      return existing;
    }
    for (const [oldKey, record] of this.members)
      if (record.validUntil <= Date.now()) {
        record.release();
        this.members.delete(oldKey);
      }
    const release = this.memberMetadata.reserve(4096 + selectorKey(selector).length * 8);
    const record: { entry?: PublicationEntry; validUntil: number; release(): void } = {
      validUntil: Date.now() + this.config.resources.work.handoffMs,
      release,
    };
    this.members.set(key, record);
    return record;
  }
  async resolve(viewId: string, selectors: ResourceSelector[]) {
    await this.observe();
    if (selectors.length > 128) throw new RangeError('at most 128 resource selectors are allowed');
    const view = await this.sessions.get(viewId);
    const resources: ResolvedResource[] = [];
    const issued: ArtifactRef[] = [];
    let validUntil = Date.now() + this.config.resources.work.handoffMs;
    try {
      for (const raw of selectors) {
        const selector = parseResourceSelector(raw);
        if (view.world && 'world' in selector && selector.world !== view.world)
          throw new TypeError('selector belongs to a different world than this resource view');
        const key = viewId + selectorKey(selector);
        let entry: PublicationEntry | undefined;
        if (view.head.mode === 'public') entry = await this.publishedEntry(view, selector);
        else {
          const slot = this.reserveMember(key, selector);
          const known = slot.entry ?? this.root?.entries.find((e) => selectorKey(e.selector) === selectorKey(selector));
          if (
            known &&
            selector.kind !== 'overlay-media' &&
            this.repo().lease(known.artifact) &&
            (!known.image || this.repo().lease(known.image))
          )
            entry = known;
          else {
            try {
              entry = (await this.generator.generate(selector, view.head.generation)) ?? undefined;
            } catch (error) {
              if (!slot.entry) {
                slot.release();
                this.members.delete(key);
              }
              throw error;
            }
          }
          if (entry) slot.entry = entry;
          else {
            slot.release();
            this.members.delete(key);
          }
        }
        if (!entry) {
          if (selector.kind !== 'chunk' && selector.kind !== 'texture')
            throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'selected resource is unavailable');
          resources.push({ selector, missing: true });
          continue;
        }
        try {
          if (view.head.mode === 'server' && selector.kind !== 'overlay-media')
            for (const ref of [entry.artifact, ...(entry.image ? [entry.image] : [])]) {
              validUntil = Math.min(validUntil, this.repo().promise(ref).validUntil);
              issued.push(ref);
            }
          resources.push(this.resolved(view, entry));
        } finally {
          this.generator.release(entry);
        }
      }
      // A batch can yield between members, including when every member is a
      // cache hit. Never issue a mixed-generation batch after a source write.
      if (view.head.mode === 'server' && view.head.generation !== this.coordinator.generation)
        throw new ResourceError('RESOURCE_VIEW_EXPIRED', 'resource source changed while resolving the batch', true);
      return { viewId, validUntil, resources };
    } catch (error) {
      for (const ref of issued) this.repo().cancelPromise(ref);
      throw error;
    }
  }
  async open(viewId: string, kind: ResourceKind, digest: string) {
    if (this.config.resources.delivery.mode !== 'server')
      throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'application body delivery is disabled');
    const view = await this.sessions.get(viewId, true);
    for (const [key, record] of this.members) {
      const entry = record.entry;
      if (!entry) continue;
      if (!key.startsWith(viewId)) continue;
      const artifact = kind === 'atlas-image' ? entry.image : entry.artifact;
      if (!artifact || artifact.digest !== digest || (kind !== 'atlas-image' && family(entry.selector) !== kind))
        continue;
      if (entry.selector.kind === 'overlay-media') {
        const s = entry.selector;
        const media = await this.content!.openPublicMedia(s.mapId, s.dimension, s.assetId, s.versionId);
        return { artifact, read: (range?: { start: number; end: number }) => media.read(range) };
      }
      return {
        artifact,
        read: async (range?: { start: number; end: number }) => {
          let replacement: PublicationEntry | null | undefined;
          try {
            if (!this.repo().lease(artifact)) {
              replacement = await this.generator.generate(entry.selector, view.head.generation);
              if (
                !replacement ||
                replacement.artifact.digest !== entry.artifact.digest ||
                replacement.image?.digest !== entry.image?.digest
              )
                throw new ResourceError(
                  'RESOURCE_VIEW_EXPIRED',
                  'resource is no longer available from its fixed source',
                );
            }
            const lease = await this.repo().acquire(artifact);
            return {
              bytes: range ? lease.bytes.subarray(range.start, range.end + 1) : lease.bytes,
              release: lease.release,
              transfer: lease.transfer,
            };
          } finally {
            if (replacement) this.generator.release(replacement);
          }
        },
      };
    }
    throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'resource is not a member of this view');
  }
  /** Existing business reads use the same prepared actions and body repository. */
  async businessResource(selector: ResourceSelector) {
    const head = await this.head('world' in selector ? selector.world : undefined);
    const result = (await this.resolve(head.viewId, [selector])).resources[0];
    if ('missing' in result) return null;
    if (!('resource' in result)) throw new TypeError('business body requires a single resource');
    const { resource } = result;
    if (head.mode === 'server') return this.open(head.viewId, resource.kind, resource.artifact.digest);
    return {
      artifact: resource.artifact,
      read: (range?: { start: number; end: number }) =>
        this.repo().readObject(
          this.mounts.resourceTarget!,
          publicObjectKey(resource.artifact),
          resource.artifact,
          range,
        ),
    };
  }
  async overlays(mapId: string, dimension: string, viewId: string): Promise<OverlayManifest> {
    const view = await this.sessions.get(viewId);
    const snapshot =
      view.head.mode === 'public'
        ? view.publication!.overlays.find((m) => m.mapId === mapId && m.dimension === dimension)
        : await this.content?.snapshot(mapId, dimension);
    if (!snapshot) throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'overlay snapshot is not available');
    const media = [];
    for (const version of snapshot.media) {
      const batch = await this.resolve(viewId, [
        { kind: 'overlay-media', mapId, dimension, assetId: version.assetId, versionId: version.versionId },
      ]);
      const item = batch.resources[0];
      if (!('resource' in item)) throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'overlay media is not published');
      media.push({ version, resource: item.resource });
    }
    return { ...snapshot, schemaVersion: 2, media };
  }
  async atlas(ids: string[]): Promise<TextureAtlasManifest> {
    const view = await this.head();
    if (!Array.isArray(ids) || ids.length > 2048 || ids.some((id) => typeof id !== 'string' || id.length > 256))
      throw new TypeError('invalid explicit atlas set');
    let textureSetId = 'default';
    if (view.mode === 'server') {
      textureSetId = this.generator.registerTextureSet(ids, this.config.resources.work.handoffMs);
    }
    const result = (await this.resolve(view.viewId, [{ kind: 'atlas', textureSetId }])).resources[0];
    if (!('manifest' in result)) throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'atlas unavailable');
    const bytes =
      view.mode === 'server'
        ? this.repo().open(result.manifest.artifact)
        : await new ContentAddressedStorage(this.mounts.resourceTarget!).read(
            result.manifest.artifact,
            publicObjectKey(result.manifest.artifact),
          );
    if (!bytes) throw new ResourceError('RESOURCE_BACKEND_UNAVAILABLE', 'atlas manifest is missing');
    const atlasData = JSON.parse(new TextDecoder().decode(bytes)) as AtlasDocument;
    if (ids.some((id) => !Object.hasOwn(atlasData.index, id)))
      throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'texture set is not in the current render root');
    return {
      cacheKey: result.manifest.artifact.digest,
      image: result.image,
      width: atlasData.width,
      height: atlasData.height,
      index: atlasData.index,
      avgColors: atlasData.avgColors,
      hasAlpha: atlasData.hasAlpha,
    };
  }
  async worlds(): Promise<WorldInfo[]> {
    if (this.config.resources.delivery.mode === 'server') {
      const worlds = await this.dynamic!.worldStore.listWorlds();
      if (!this.content) return worlds;
      try {
        const maps = await this.content.listMaps();
        return worlds.map((world) => ({
          ...world,
          mapIds: maps.filter((map) => map.worldKey === world.id).map((map) => map.mapId),
        }));
      } catch {
        // Optional overlay metadata cannot make the world inventory unavailable.
        return worlds;
      }
    }
    const view = await this.sessions.get((await this.head()).viewId);
    return view.publication!.worlds;
  }
  private async projection<T>(world: string, viewId: string | undefined, read: (view: View) => Promise<T>): Promise<T> {
    const id = viewId ?? (await this.head(world)).viewId;
    const run = async () => {
      const view = await this.sessions.get(id);
      if (view.world && view.world !== world) throw new TypeError('projection belongs to a different world');
      const result = await read(view);
      if (view.head.mode === 'server' && view.head.generation !== this.coordinator.generation)
        throw new ResourceError('RESOURCE_VIEW_EXPIRED', 'source changed while reading resource metadata', true);
      return result;
    };
    return this.config.resources.delivery.mode === 'server' ? this.sourceGate.read(run) : run();
  }
  async coverage(world: string, dimension: string, viewId?: string): Promise<ChunkCoverage> {
    return this.projection(world, viewId, async (view) =>
      view.head.mode === 'server'
        ? this.dynamic!.worldStore.listChunkSourceCoverage(world, dimension)
        : (view.publication!.coverage[projectionKey(world, dimension)] ?? { regions: [], chunks: [] }),
    );
  }
  async topMap(world: string, dimension: string, viewId?: string): Promise<TopMapDimensionManifest | null> {
    return this.projection(world, viewId, async (view) => {
      if (view.head.mode === 'public') return view.publication!.topMaps[projectionKey(world, dimension)] ?? null;
      const dimensionData = (await this.dynamic!.topMap.getTopMapManifest(world))?.dimensions[dimension];
      return dimensionData ? { ...dimensionData, world, dimension } : null;
    });
  }
  async worldCapabilities(world: string, viewId?: string): Promise<WorldCapabilities> {
    return this.projection(world, viewId, async (view) => {
      const worlds =
        view.head.mode === 'public' ? view.publication!.worlds : await this.dynamic!.worldStore.listWorlds();
      const found = worlds.find((w) => w.id === world);
      const dimensions: WorldCapabilities['dimensions'] = {};
      const top = view.head.mode === 'server' ? await this.dynamic!.topMap.getTopMapManifest(world) : undefined;
      for (const dim of found?.dimensions ?? [])
        dimensions[dim] = {
          hasTopMap:
            view.head.mode === 'public'
              ? !!view.publication!.topMaps[projectionKey(world, dim)]?.hasTopMap
              : !!top?.dimensions[dim]?.hasTopMap,
        };
      return { world, dimensions, hasTopMap: Object.values(dimensions).some((d) => d.hasTopMap) };
    });
  }
  async mutateSource<T>(operation: () => Promise<T>, domain: 'source' | 'content' = 'source'): Promise<T> {
    return this.sourceGate.write(async () => {
      if (domain === 'source') {
        this.invalidate();
        this.publication.state.requiresSourceSnapshot = true;
        if (this.store && this.config.resources.roles.includes('publish'))
          await this.store.pending('pending', undefined, true);
      }
      try {
        const result = await operation();
        if (domain === 'content') {
          this.publication.state.publication = 'pending';
          if (this.store && this.config.resources.roles.includes('publish')) {
            try {
              await this.store.pending('pending', undefined, this.publication.state.requiresSourceSnapshot);
            } catch {
              this.publication.state.error = 'RESOURCE_BACKEND_UNAVAILABLE';
            }
          }
          this.publication.schedule();
        }
        return result;
      } finally {
        if (domain === 'source') this.invalidate();
      }
    });
  }
  async status() {
    return {
      ...this.publication.state,
      storage: this.mounts.metrics?.() ?? [],
      mode: this.config.resources.delivery.mode,
      roles: this.config.resources.roles,
      head: (await this.store?.head()) ?? null,
      durablePublicationState: (await this.store?.publicationState()) ?? null,
      cache: this.repository
        ? {
            memoryBytes: this.repository.cache.bytes,
            handoffBytes: this.repository.handoff.budget.bytes,
            workBytes: this.repository.work.bytes,
            queuedBytes: this.repository.work.queuedBytes,
            waitingForWork: this.repository.work.queuedTasks,
            metrics: this.repository.metrics,
            cacheMetrics: this.repository.cache.metrics,
            coalescedWaiters:
              this.repository.prepares.coalesced + this.repository.tasks.coalesced + this.operations.coalesced,
            memberMetadataBytes: this.memberMetadata.bytes,
            handoffExpired: this.repository.handoff.expired,
            queuedTasks: this.repository.prepares.size + this.repository.tasks.size,
            publicMetrics: this.target?.metrics ?? null,
            publicationMetrics: this.store?.metrics ?? null,
          }
        : null,
    };
  }
}
