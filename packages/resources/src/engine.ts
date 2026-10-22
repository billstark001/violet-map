import type { ResourceEngineConfig, ResourceEngineMounts, DynamicSources, ContentSource } from './engineTypes.js';
import { resourceJsonBytes, projectionKey } from './engineSupport.js';
import { ResourceGenerator, type GenerationInputs } from './generator.js';
import { ResourceViewSessions, type View } from './viewSessions.js';
import { ResourcePublisher } from './publisher.js';
import { mapWithConcurrency } from '@violet-map/core/async';
import { isWorldName } from '@violet-map/core/domain';
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

interface Member {
  entry?: PublicationEntry;
  validUntil: number;
  users: number;
  bodyKeys: string[];
  release(): void;
}

export class ResourceEngine {
  private readonly generator: ResourceGenerator;
  private readonly sessions: ResourceViewSessions;
  readonly publication: ResourcePublisher;
  private bounded?: BoundedSource;
  private readonly worldObservations = new Map<string, { source: BoundedSource; lastUsed: number }>();
  private observationTimer?: ReturnType<typeof setTimeout>;
  private readonly observationController = new AbortController();
  private closed = false;
  private readonly operations: Singleflight;
  private readonly members = new Map<string, Member>();
  private readonly bodies = new Map<string, Set<Member>>();
  private readonly memberMetadata: ByteBudget;
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
    // Coordination can enclose admitted generation. Keep bounded coordination
    // slots separate from the repository's actual task limit; publication owns
    // its own one-task gate so queued publishers cannot starve render-root work.
    this.operations = new Singleflight(Math.min(Number.MAX_SAFE_INTEGER, config.resources.work.maxTasks + 2));
    const budget = config.resources.cache.metadataBytes;
    this.memberMetadata = new ByteBudget(Math.floor(budget / 4));
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
      generator: this.generator,
      sessions: this.sessions,
      renderRoot: (token, previous) => this.renderRoot(token, previous),
      rootEntries: () => this.root?.entries ?? [],
      publicResult: async (selectors, world) => {
        const head = await this.head(world);
        const batch = await this.resolve(head.viewId, selectors);
        return { head, resources: batch.resources };
      },
    });
    if (config.resources.source.consistency === 'bounded' && dynamic)
      this.bounded = new BoundedSource(
        coordinator,
        async () => {
          const release = await this.repo().work.waitReserve(
            budget * 2 + 2 * 1024 ** 2,
            config.resources.work.maxTasks + 1,
            this.observationController.signal,
          );
          try {
            const hash = createHash('sha256');
            hash.update(await dynamic.assets.sourceRevision());
            hash.update(resourceJsonBytes(await dynamic.gameData.buildBlockInfo()));
            hash.update(resourceJsonBytes(await dynamic.gameData.readBiomes()));
            hash.update(resourceJsonBytes(await dynamic.gameData.readDimensions()));
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
  private worldObservation(world: string) {
    if (!isWorldName(world)) throw new TypeError('invalid world');
    let record = this.worldObservations.get(world);
    if (!record) {
      const limit = Math.max(1, Math.floor(this.config.resources.cache.metadataBytes / 32768));
      if (this.worldObservations.size >= limit) {
        const idle = [...this.worldObservations].find(([, value]) => !this.observationActive(value));
        if (!idle) throw new ResourceError('RESOURCE_BUSY', 'active source observations exhaust metadata budget', true);
        this.worldObservations.delete(idle[0]);
        // Dropping an old fingerprint must expire its views and action keys;
        // reactivation cannot silently accept bytes from an unobserved interval.
        this.invalidate();
      }
      record = {
        lastUsed: Date.now(),
        source: new BoundedSource(
          this.coordinator,
          async () => {
            const budget = this.config.resources.cache.metadataBytes;
            const release = await this.repo().work.waitReserve(
              budget * 2 + 2 * 1024 ** 2,
              this.config.resources.work.maxTasks + 1,
              this.observationController.signal,
            );
            try {
              const hash = createHash('sha256');
              const files = await this.mounts.worlds!.list(world);
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
                  const bytes = await this.mounts.worlds!.readRange(file.path, offset, length);
                  if (!bytes || bytes.byteLength !== length)
                    throw new ResourceError('SOURCE_SNAPSHOT_CHANGED', 'source changed during observation', true);
                  hash.update(bytes);
                }
              }
              return hash.digest('hex');
            } finally {
              release();
            }
          },
          this.config.resources.source.revalidateMs,
        ),
      };
      this.worldObservations.set(world, record);
    }
    record.lastUsed = Date.now();
    return record.source;
  }
  private observationActive(record: { lastUsed: number }) {
    return Date.now() - record.lastUsed <= Math.max(30000, this.config.resources.work.handoffMs);
  }
  private async observe(worlds: string[] = [], force = false) {
    if (this.closed) throw new ResourceError('RESOURCE_BUSY', 'resource engine is closed', true);
    if (!this.bounded) return;
    const before = this.coordinator.generation;
    let failed = true;
    try {
      const requested = [...new Set(worlds)].map((world) => this.worldObservation(world));
      await this.bounded.validate(force);
      const active = force
        ? [...this.worldObservations.values()]
            .filter((record) => this.observationActive(record))
            .map((record) => record.source)
        : requested;
      await mapWithConcurrency(active, 2, (source) => source.validate(force));
      this.publication.state.sourceObservedAt = Math.min(
        this.bounded.sourceObservedAt,
        ...active.map((source) => source.sourceObservedAt),
      );
      if (before !== this.coordinator.generation) {
        this.root = undefined;
        this.dynamic!.assets.clearTextureAtlasCache();
        for (const file of await this.mounts.worlds!.list()) this.dynamic!.worldStore.invalidateStoredFile(file.path);
      }
      failed = false;
    } finally {
      if (!this.closed && !this.observationTimer) {
        this.observationTimer = setTimeout(
          () => {
            this.observationTimer = undefined;
            void this.observe([], true).catch((error) => {
              this.publication.state.error =
                error instanceof ResourceError ? error.code : 'RESOURCE_BACKEND_UNAVAILABLE';
            });
          },
          failed
            ? this.config.resources.source.revalidateMs
            : Math.min(
                this.bounded.refreshDelayMs,
                ...[...this.worldObservations.values()]
                  .filter((record) => this.observationActive(record))
                  .map((record) => record.source.refreshDelayMs),
              ),
        );
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
    await this.publication.drain();
    await Promise.all(
      [this.bounded, ...[...this.worldObservations.values()].map((record) => record.source)].map((source) =>
        source?.drain(),
      ),
    ).catch((error) => {
      if (error !== this.observationController.signal.reason) throw error;
    });
    this.worldObservations.clear();
    for (const value of this.members.values()) value.release();
    this.members.clear();
    this.bodies.clear();
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
    await this.observe(world ? [world] : []);
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
      const inputs: GenerationInputs = {};
      try {
        for (const selector of selectors) {
          const old = previous?.entries.find((e) => selectorKey(e.selector) === selectorKey(selector));
          if (old) await this.repo().rememberAction(old.actionKey, old.artifact);
          const entry = await this.generator.generate(selector, generation, token, undefined, inputs);
          if (!entry && selector.kind === 'texture') continue;
          if (!entry) throw new ResourceError('RESOURCE_BACKEND_UNAVAILABLE', 'render root resource is missing');
          entries.push(entry);
          if (selector.kind === 'asset-bundle') inputs.bundle = entry.artifact;
          if (selector.kind === 'game-data' && selector.name === 'blocks') inputs.blocks = entry.artifact;
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
    return this.store!.entry(view.publication!, selector);
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
      existing.users++;
      return existing;
    }
    for (const [oldKey, record] of this.members)
      if (!record.users && record.validUntil <= Date.now()) {
        record.release();
        this.members.delete(oldKey);
      }
    const release = this.memberMetadata.reserve(4096 + selectorKey(selector).length * 8);
    const record: Member = {
      validUntil: Date.now() + this.config.resources.work.handoffMs,
      users: 1,
      bodyKeys: [],
      release: () => {
        for (const bodyKey of record.bodyKeys) {
          const records = this.bodies.get(bodyKey);
          records?.delete(record);
          if (!records?.size) this.bodies.delete(bodyKey);
        }
        record.bodyKeys = [];
        release();
      },
    };
    this.members.set(key, record);
    return record;
  }
  private async serverEntry(
    viewId: string,
    selector: ResourceSelector,
    generation: number,
    signal: AbortSignal,
    releases: (() => void)[],
  ) {
    const key = viewId + selectorKey(selector);
    const slot = this.reserveMember(key, selector);
    releases.push(() => {
      if (--slot.users === 0 && !slot.entry) {
        slot.release();
        if (this.members.get(key) === slot) this.members.delete(key);
      }
    });
    const known = slot.entry ?? this.root?.entries.find((e) => selectorKey(e.selector) === selectorKey(selector));
    const entry =
      known &&
      selector.kind !== 'overlay-media' &&
      this.repo().lease(known.artifact) &&
      (!known.image || this.repo().lease(known.image))
        ? known
        : ((await this.generator.generate(selector, generation, undefined, signal)) ?? undefined);
    if (entry && slot.entry !== entry) {
      slot.entry = entry;
      const refs = [[family(selector), entry.artifact], ...(entry.image ? [['atlas-image', entry.image]] : [])] as [
        ResourceKind,
        ArtifactRef,
      ][];
      for (const [kind, ref] of refs) {
        const bodyKey = viewId + ':' + kind + ':' + ref.digest;
        if (slot.bodyKeys.includes(bodyKey)) continue;
        const records = this.bodies.get(bodyKey) ?? new Set<Member>();
        records.add(slot);
        this.bodies.set(bodyKey, records);
        slot.bodyKeys.push(bodyKey);
      }
    }
    return entry;
  }
  async resolve(viewId: string, selectors: ResourceSelector[], signal?: AbortSignal) {
    const deadline = AbortSignal.timeout(25000);
    const lifetime = signal ? AbortSignal.any([signal, deadline]) : deadline;
    lifetime.throwIfAborted();
    if (selectors.length > 128) throw new RangeError('at most 128 resource selectors are allowed');
    selectors = selectors.map(parseResourceSelector);
    await this.observe(selectors.flatMap((selector) => ('world' in selector ? [selector.world] : [])));
    const view = await this.sessions.get(viewId);
    lifetime.throwIfAborted();

    const issued: ArtifactRef[] = [];
    const memberReleases: (() => void)[] = [];
    let validUntil = Date.now() + this.config.resources.work.handoffMs;
    try {
      const resources = await mapWithConcurrency(selectors, 2, async (selector): Promise<ResolvedResource> => {
        lifetime.throwIfAborted();
        if (view.world && 'world' in selector && selector.world !== view.world)
          throw new TypeError('selector belongs to a different world than this resource view');
        let entry: PublicationEntry | undefined;
        if (view.head.mode === 'public') entry = await this.publishedEntry(view, selector);
        else entry = await this.serverEntry(viewId, selector, view.head.generation, lifetime, memberReleases);
        if (!entry) {
          if (selector.kind !== 'chunk' && selector.kind !== 'texture')
            throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'selected resource is unavailable');
          return { selector, missing: true };
        }
        try {
          if (view.head.mode === 'server' && selector.kind !== 'overlay-media')
            for (const ref of [entry.artifact, ...(entry.image ? [entry.image] : [])]) {
              validUntil = Math.min(validUntil, this.repo().promise(ref).validUntil);
              issued.push(ref);
            }
          return this.resolved(view, entry);
        } finally {
          this.generator.release(entry);
        }
      });
      // A batch can yield between members, including when every member is a
      // cache hit. Never issue a mixed-generation batch after a source write.
      if (view.head.mode === 'server' && view.head.generation !== this.coordinator.generation)
        throw new ResourceError('RESOURCE_VIEW_EXPIRED', 'resource source changed while resolving the batch', true);
      lifetime.throwIfAborted();
      // The delivery window begins when the entire batch is ready. A pin that
      // expired during preparation is an explicit retry, never a successful
      // response containing dead references.
      validUntil = Date.now() + this.config.resources.work.handoffMs;
      for (const ref of issued) validUntil = Math.min(validUntil, this.repo().renewPromise(ref));
      for (const selector of selectors) {
        const member = this.members.get(viewId + selectorKey(selector));
        if (member) member.validUntil = validUntil;
      }
      return { viewId, validUntil, resources };
    } catch (error) {
      for (const ref of issued) this.repo().cancelPromise(ref);
      if (deadline.aborted && !signal?.aborted)
        throw new ResourceError('RESOURCE_BUSY', 'resource resolution deadline exceeded', true);
      throw error;
    } finally {
      for (const release of memberReleases) release();
    }
  }
  async open(viewId: string, kind: ResourceKind, digest: string) {
    if (this.config.resources.delivery.mode !== 'server')
      throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'application body delivery is disabled');
    const view = await this.sessions.get(viewId, true);
    for (const record of this.bodies.get(viewId + ':' + kind + ':' + digest) ?? []) {
      const entry = record.entry;
      if (!entry) continue;
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
    for (let offset = 0; offset < snapshot.media.length; offset += 128) {
      const versions = snapshot.media.slice(offset, offset + 128);
      const batch = await this.resolve(
        viewId,
        versions.map((version) => ({
          kind: 'overlay-media',
          mapId,
          dimension,
          assetId: version.assetId,
          versionId: version.versionId,
        })),
      );
      for (let i = 0; i < versions.length; i++) {
        const version = versions[i];
        const item = batch.resources[i];
        if (!('resource' in item)) throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'overlay media is not published');
        media.push({ version, resource: item.resource });
      }
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
    await this.observe([world]);
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
      task: this.publication.taskStatus(),
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
