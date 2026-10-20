import { collectTextureIds } from '@violet-map/core/assets';
import { LruCache } from '@violet-map/core/cache';
import type {
  AtlasDocument,
  ChunkCoverage,
  TextureAtlasManifest,
  TopMapDimensionManifest,
  WorldCapabilities,
  WorldInfo,
} from '@violet-map/core/contracts';
import { isWorldName } from '@violet-map/core/domain';
import type { OverlayManifest } from '@violet-map/core/overlays';
import {
  canonicalJson,
  mediaArtifact,
  parseArtifactRef,
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
import { createHash, randomUUID } from 'node:crypto';
import type { AssetPack } from './assetPack.js';
import type { ArtifactRead, BlobRepository, PreparedResource } from './blobRepository.js';
import { ByteBudget } from './budget.js';
import { ResourceDelivery } from './delivery.js';
import { collectPublicationGarbage } from './gc.js';
import type { InvalidationCoordinator } from './invalidation.js';
import { actionKey } from './keys.js';
import { regionPage, selectorKey, type PublicationStore } from './publication.js';
import type { PublicTarget } from './publicTarget.js';
import { Singleflight } from './singleflight.js';
import { SnapshotGate, type SnapshotToken } from './snapshotGate.js';
import { BoundedSource } from './sourceSnapshot.js';

export interface ResourceEngineConfig {
  resources: {
    roles: ('serve' | 'publish')[];
    cache: { metadataBytes: number };
    work: { handoffMs: number };
    source: { scope: string; consistency: 'snapshot' | 'bounded'; revalidateMs: number };
    publication: { debounceMs: number; maxDelayMs: number; retainedMs: number };
    delivery: { mode: 'server' | 'public'; publicBaseUrl: string | null };
  };
  sourceIdentity: string;
}

export interface ResourceEngineMounts {
  metrics?(): unknown;
  worlds?: import('@violet-map/core/storage').ObjectReader;
  resourceTarget?: import('@violet-map/core/storage').ObjectReader;
}

export interface GameDataSource {
  buildBlockInfo(): Promise<import('@violet-map/core/assets').BlockInfoMap>;
  readBiomes(): Promise<import('@violet-map/core/domain').BiomeMap>;
  readDimensions(): Promise<import('@violet-map/core/domain').DimensionMap>;
}

export interface TopMapSource {
  getTopMapManifest(world: string): Promise<import('@violet-map/core/formats/top-map').TopMapManifest | null>;
  readTopMapTile(world: string, dim: string, rx: number, rz: number): Promise<Uint8Array | null>;
}

export interface ContentSource {
  openPublicMedia(
    mapId: string,
    dimension: string,
    assetId: string,
    versionId: string,
  ): Promise<{
    version: import('@violet-map/core/overlays').MediaVersion;
    read(range?: { start: number; end: number }): Promise<ArtifactRead>;
  }>;
  snapshot(mapId: string, dimension: string): Promise<import('@violet-map/core/overlays').OverlaySnapshot>;
  listMaps(): Promise<import('@violet-map/core/overlays').MapDocument[]>;
}

export interface DynamicSources {
  assets: AssetPack;
  worldStore: Pick<
    import('./sources/worldChunks.js').WorldSource,
    'listWorlds' | 'listChunkSourceCoverage' | 'getChunkNbtWithMeta' | 'invalidateStoredFile'
  >;
  topMap: TopMapSource;
  gameData: GameDataSource;
}

interface View {
  head: ResourceViewHead;
  createdAt: number;
  expiresAt?: number;
  world?: string;
  publication?: PublicationManifest;
}

const bytesJson = (value: unknown) => new TextEncoder().encode(canonicalJson(JSON.parse(JSON.stringify(value))));

const projectionKey = (world: string, dimension: string) => canonicalJson([world, dimension]);

const family = (s: ResourceSelector): ResourceKind => (s.kind === 'atlas' ? 'atlas-manifest' : s.kind);

export class ResourceEngine {
  private bounded?: BoundedSource;
  private observationTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private publicationTimer?: ReturnType<typeof setTimeout>;
  private dirtySince = 0;
  private readonly bootId = randomUUID();
  private readonly operations = new Singleflight(16);
  private readonly views = new Map<string, View>();
  private readonly members = new Map<string, { entry?: PublicationEntry; validUntil: number; release(): void }>();
  private readonly memberMetadata: ByteBudget;
  private readonly pages: LruCache<string, import('@violet-map/core/resources').RegionResourcePage>;
  private readonly textureSets = new Map<string, { ids: string[]; until: number; release(): void }>();
  private readonly generationLeases = new WeakMap<PublicationEntry, () => void>();
  private previousPublication?: PublicationManifest;
  private readonly sourceGate = new SnapshotGate();
  private root?: { generation: number; digest: string; entries: PublicationEntry[] };
  private readonly delivery: ResourceDelivery;
  readonly state = {
    publication: 'ready' as 'ready' | 'pending' | 'failed',
    error: undefined as string | undefined,
    sourceObservedAt: 0,
    publicationLagMs: 0,
    requiresSourceSnapshot: false,
  };
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
    const budget = config.resources.cache.metadataBytes;
    this.memberMetadata = new ByteBudget(Math.floor(budget / 4));
    this.pages = new LruCache({ maxEntries: 16, maxWeight: budget / 4, weightOf: (p) => bytesJson(p).byteLength * 4 });
    if (config.resources.source.consistency === 'bounded' && dynamic)
      this.bounded = new BoundedSource(
        coordinator,
        async () => {
          const hash = createHash('sha256');
          hash.update(await dynamic.assets.sourceDigest());
          hash.update(bytesJson(await dynamic.gameData.buildBlockInfo()));
          hash.update(bytesJson(await dynamic.gameData.readBiomes()));
          hash.update(bytesJson(await dynamic.gameData.readDimensions()));
          const files = await mounts.worlds!.list();
          if (files.length > Math.floor(budget / 1024))
            throw new ResourceError('RESOURCE_BUSY', 'source inventory exceeds metadata budget');
          for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
            if (
              !/\.(mca|nbt|msgpack)$|\/(level.dat|identity.json|world.json)$|\/top-map\/manifest.json$/.test(file.path)
            )
              continue;
            hash.update(canonicalJson({ key: file.path, bytes: file.size }));
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
      this.state.sourceObservedAt = this.bounded.sourceObservedAt;
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
            this.state.error = error instanceof ResourceError ? error.code : 'RESOURCE_BACKEND_UNAVAILABLE';
          });
        }, this.config.resources.source.revalidateMs);
        this.observationTimer.unref();
      }
    }
  }

  async close() {
    this.closed = true;
    if (this.publicationTimer) clearTimeout(this.publicationTimer);
    if (this.observationTimer) clearTimeout(this.observationTimer);
    this.observationTimer = undefined;
    await this.operations.close();
    await this.bounded?.drain();
    for (const value of this.members.values()) value.release();
    this.members.clear();
    for (const value of this.textureSets.values()) value.release();
    this.textureSets.clear();
  }
  private schedulePublication() {
    if (this.closed || this.state.requiresSourceSnapshot || !this.config.resources.roles.includes('publish')) return;
    this.dirtySince ||= Date.now();
    if (this.publicationTimer) clearTimeout(this.publicationTimer);
    const options = this.config.resources.publication;
    const delay = Math.max(0, Math.min(options.debounceMs, options.maxDelayMs - (Date.now() - this.dirtySince)));
    this.publicationTimer = setTimeout(() => {
      this.publicationTimer = undefined;
      this.dirtySince = 0;
      if (this.state.requiresSourceSnapshot) return;
      void this.publish().catch(async (error) => {
        this.state.publication = 'failed';
        this.state.error = error instanceof ResourceError ? error.code : 'RESOURCE_BACKEND_UNAVAILABLE';
        try {
          await this.store?.pending('failed', this.state.error, this.state.requiresSourceSnapshot);
        } catch {
          this.state.error = 'RESOURCE_BACKEND_UNAVAILABLE';
        }
      });
    }, delay);
    this.publicationTimer.unref();
  }
  async resumePublications() {
    if (!this.config.resources.roles.includes('publish') || !this.store) return;
    // Reconcile even if a crash happened after a business head commit but
    // before its pending marker. A stable closure remains a zero-write no-op.
    const pending = await this.store.publicationState();
    this.state.requiresSourceSnapshot = pending?.requiresSourceSnapshot === true;
    if (pending || (await this.store.head())) {
      this.state.publication = 'pending';
      this.schedulePublication();
    }
  }
  invalidate() {
    this.coordinator.invalidate();
    this.root = undefined;
    this.state.sourceObservedAt = Date.now();
    if (this.config.resources.roles.includes('publish') || this.config.resources.delivery.mode === 'public')
      this.state.publication = 'pending';
  }
  private repo(): BlobRepository {
    if (!this.repository) throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'dynamic resource generation is disabled');
    return this.repository;
  }
  private async sourceScope(world?: string): Promise<string> {
    if (!world) return sha256(canonicalJson({ scope: this.config.resources.source.scope }));
    if (!isWorldName(world)) throw new TypeError('invalid world');
    const identity = await this.mounts.worlds?.read(`${world}/.violet-map/identity.json`);
    let archive: string | null = null;
    if (identity) {
      const value = JSON.parse(new TextDecoder().decode(identity));
      if (value.schema !== 1 || typeof value.id !== 'string')
        throw new ResourceError('SOURCE_REVISION_UNAVAILABLE', 'invalid world archive identity');
      archive = value.id;
    }
    return sha256(
      canonicalJson({
        scope: this.config.resources.source.scope,
        world,
        archive,
        locator: archive ? null : this.config.sourceIdentity,
      }),
    );
  }
  async head(world?: string): Promise<ResourceViewHead> {
    await this.observe();
    return this.config.resources.delivery.mode === 'public'
      ? this.snapshotHead(world)
      : this.sourceGate.read((token) => this.snapshotHead(world, token));
  }
  private async snapshotHead(world: string | undefined, token?: SnapshotToken): Promise<ResourceViewHead> {
    if (!this.config.resources.roles.includes('serve') && !this.config.resources.roles.includes('publish'))
      throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'resource role disabled');
    if (this.config.resources.delivery.mode === 'public') {
      const head = await this.store?.head();
      if (!head) throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'no complete resource publication exists');
      let view = this.views.get(head.publicationId);
      if (!view) {
        const publication = await this.store!.manifest(head);
        view = {
          head: {
            schemaVersion: 1,
            viewId: head.publicationId,
            mode: 'public',
            sourceScope: publication.sourceScope,
            generation: head.revision,
            renderRoot: publication.renderRoot,
            publicationId: head.publicationId,
          },
          publication,
          createdAt: Date.now(),
        };
        this.retainView(head.publicationId, { ...view, publication: undefined });
      }
      if (world) {
        if (!isWorldName(world)) throw new TypeError('invalid world');
        const publication = view.publication ?? (await this.store!.manifest(head));
        return {
          ...view.head,
          sourceScope:
            publication.sourceScopes[world] ??
            (() => {
              throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'world is not part of this publication');
            })(),
        };
      }
      return view.head;
    }
    const root = await this.renderRoot(token);
    for (const entry of root.entries) this.discardPreparedBytes(entry);
    const sourceScope = await this.sourceScope(world);
    const viewId = sha256(
      canonicalJson({
        boot: this.bootId,
        sourceScope,
        generation: this.coordinator.generation,
        renderRoot: root.digest,
        session: Math.floor(Date.now() / 86400000),
      }),
    );
    const head: ResourceViewHead = {
      schemaVersion: 1,
      viewId,
      mode: 'server',
      sourceScope,
      generation: this.coordinator.generation,
      renderRoot: root.digest,
    };
    this.retainView(viewId, { head, world, createdAt: Date.now() });
    return head;
  }
  private retainView(id: string, view: View) {
    const existing = this.views.get(id);
    if (existing) {
      existing.expiresAt = Date.now() + this.config.resources.work.handoffMs;
      return;
    }
    view.expiresAt = Date.now() + this.config.resources.work.handoffMs;
    for (const [key, value] of this.views)
      if (Date.now() - value.createdAt > 86400000 || (value.expiresAt ?? 0) < Date.now()) this.views.delete(key);
    const cost = (v: View) => 1024 + (v.publication ? bytesJson(v.publication).byteLength * 4 : 0);
    const total = [...this.views.values()].reduce((sum, v) => sum + cost(v), 0);
    if (total + cost(view) > this.config.resources.cache.metadataBytes / 8)
      throw new ResourceError('RESOURCE_BUSY', 'active resource views exhaust metadata budget', true);
    this.views.set(id, view);
  }
  private async view(viewId: string, materialized = false): Promise<View> {
    let view = this.views.get(viewId);
    if (this.config.resources.delivery.mode === 'public') {
      const retained = await this.store!.retainedHead(viewId);
      if (!retained) throw new ResourceError('RESOURCE_VIEW_EXPIRED', 'publication is no longer retained', true);
      const publication = await this.store!.manifest(retained);
      return {
        head: {
          schemaVersion: 1,
          viewId,
          mode: 'public',
          sourceScope: publication.sourceScope,
          generation: retained.revision,
          renderRoot: publication.renderRoot,
          publicationId: viewId,
        },
        createdAt: Date.now(),
        publication,
      };
    }
    if (!view || Date.now() - view.createdAt > 86400000)
      throw new ResourceError('RESOURCE_VIEW_EXPIRED', 'resource view expired; refresh its head', true);
    if (view.head.mode === 'server' && !materialized && view.head.generation !== this.coordinator.generation)
      throw new ResourceError('RESOURCE_VIEW_EXPIRED', 'resource source generation changed', true);
    return view;
  }
  private async renderRoot(token?: SnapshotToken) {
    return this.sourceGate.read((snapshot) => this.renderRootSnapshot(snapshot), token);
  }
  private async renderRootSnapshot(token: SnapshotToken) {
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
          const old = this.previousPublication?.entries.find((e) => selectorKey(e.selector) === selectorKey(selector));
          if (old) await this.repo().rememberAction(old.actionKey, old.artifact);
          const entry = await this.generate(selector, generation, token);
          if (!entry && selector.kind === 'texture') continue;
          if (!entry) throw new ResourceError('RESOURCE_BACKEND_UNAVAILABLE', 'render root resource is missing');
          entries.push(entry);
        }
        this.coordinator.assert(generation);
        const root = { generation, digest: sha256(canonicalJson(entries)), entries };
        this.root = root;
        return root;
      } catch (error) {
        for (const entry of entries) this.discardPreparedBytes(entry);
        throw error;
      }
    });
  }
  private async generate(
    selector: ResourceSelector,
    generation: number,
    token?: SnapshotToken,
  ): Promise<PublicationEntry | null> {
    if (token)
      return this.sourceGate.read(
        (snapshot) =>
          this.operations.run('snapshot-generate:' + token.id + ':' + generation + selectorKey(selector), () =>
            this.generateSnapshot(selector, generation, snapshot),
          ),
        token,
      );
    return this.operations.run('generate:' + generation + selectorKey(selector), () =>
      this.sourceGate.read((snapshot) => this.generateSnapshot(selector, generation, snapshot)),
    );
  }
  private async generateSnapshot(
    selector: ResourceSelector,
    generation: number,
    _token: SnapshotToken,
  ): Promise<PublicationEntry | null> {
    const repo = this.repo();
    const dynamic = this.dynamic;
    if (selector.kind === 'overlay-media') {
      if (!this.content) throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'content reads are disabled');
      const { version } = await this.content.openPublicMedia(
        selector.mapId,
        selector.dimension,
        selector.assetId,
        selector.versionId,
      );
      const artifact = mediaArtifact(version);
      return {
        selector,
        artifact,
        actionKey: actionKey({
          generator: 'overlay-media',
          version: 1,
          format: artifact.format,
          params: {},
          dependencies: [{ role: 'original', digest: artifact.digest }],
        }),
      };
    }
    if (!dynamic) throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'resource source services are disabled');
    let extra: Partial<PublicationEntry> = {};
    const maxBytes =
      selector.kind === 'atlas'
        ? Math.min(32 * 1024 ** 2, repo.handoff.budget.capacity)
        : Math.min(16 * 1024 ** 2, repo.handoff.budget.capacity);
    // These bounds cover source reads, decoding and output buffers. A smaller
    // configured work budget must reject before preparation allocates them.
    const workBytes = ['atlas', 'chunk', 'top-map-tile'].includes(selector.kind) ? 128 * 1024 ** 2 : 64 * 1024 ** 2;
    const result = await repo.build(
      selectorKey(selector),
      generation,
      maxBytes,
      workBytes,
      async () => {
        if (selector.kind === 'atlas') {
          const supplied = this.textureSets.get(selector.textureSetId);
          if (selector.textureSetId !== 'default' && !supplied)
            throw new ResourceError('RESOURCE_VIEW_EXPIRED', 'explicit atlas texture set expired', true);
          const bundle = await dynamic.assets.buildAssetBundle();
          const blocks = await dynamic.gameData.buildBlockInfo();
          const prepared = await dynamic.assets.prepareTextureAtlas(supplied?.ids ?? collectTextureIds(bundle, blocks));
          return {
            actionKey: prepared.key,
            generation,
            mediaType: 'application/json',
            format: 'atlas-manifest-v1',
            maxArtifacts: 2,
            maxBytes,
            workBytes,
            related(bytes) {
              const d = JSON.parse(new TextDecoder().decode(bytes)) as AtlasDocument;
              return [parseArtifactRef(d.image)];
            },
            async generate(signal) {
              signal.throwIfAborted();
              const result = await prepared.generate();
              const bytes = bytesJson(result.manifest);
              return { bytes, related: [{ bytes: result.png, mediaType: 'image/png', format: 'png' }] };
            },
          };
        }
        let input: Uint8Array;
        let format: string;
        let mediaType: string;
        let dependencies: { role: string; digest: string }[] = [];
        let encodeInput: (() => Uint8Array) | undefined;
        if (selector.kind === 'chunk') {
          const chunk = await dynamic.worldStore.getChunkNbtWithMeta(
            selector.world,
            selector.dimension,
            selector.cx,
            selector.cz,
          );
          if (!chunk) return null;
          if (chunk.data.byteLength + (chunk.entities?.byteLength ?? 0) > Math.max(0, maxBytes - 96))
            throw new ResourceError('RESOURCE_BUSY', 'chunk cannot fit the declared MessagePack output budget');
          const { prepareChunkArtifact } = await import('./chunkArtifact.js');
          const prepared = prepareChunkArtifact({
            cx: selector.cx,
            cz: selector.cz,
            data: chunk.data,
            ...(chunk.entities ? { entities: chunk.entities } : {}),
          });
          dependencies = prepared.dependencies;
          extra = {
            terrainHash: prepared.terrainHash,
            nbtHash: prepared.nbtHash,
            ...(prepared.entityHash ? { entityHash: prepared.entityHash } : {}),
          };
          input = new Uint8Array();
          encodeInput = prepared.generate;
          format = 'chunk-msgpack-v1';
          mediaType = 'application/msgpack';
        } else if (selector.kind === 'texture') {
          const texture = await dynamic.assets.readTextureFile(selector.id);
          if (!texture) return null;
          input = texture.bytes;
          format = 'png';
          mediaType = 'image/png';
        } else if (selector.kind === 'asset-bundle') {
          input = bytesJson(await dynamic.assets.buildAssetBundle());
          format = 'asset-bundle-json-v1';
          mediaType = 'application/json';
        } else if (selector.kind === 'game-data') {
          const value =
            selector.name === 'blocks'
              ? await dynamic.gameData.buildBlockInfo()
              : selector.name === 'biomes'
                ? await dynamic.gameData.readBiomes()
                : await dynamic.gameData.readDimensions();
          input = bytesJson(value);
          format = 'game-data-json-v1';
          mediaType = 'application/json';
        } else {
          const tile = await dynamic.topMap.readTopMapTile(
            selector.world,
            selector.dimension,
            selector.rx,
            selector.rz,
          );
          if (!tile) return null;
          input = tile;
          format = 'topmap-msgpack-v6';
          mediaType = 'application/msgpack';
        }
        if (!dependencies.length) dependencies = [{ role: 'input', digest: sha256(input) }];
        const key = actionKey({
          generator: selector.kind,
          version: 1,
          format,
          params:
            selector.kind === 'chunk'
              ? { dimension: selector.dimension, cx: selector.cx, cz: selector.cz }
              : selector.kind === 'game-data'
                ? { name: selector.name }
                : {},
          dependencies,
        });
        const fixed = input;
        return {
          actionKey: key,
          generation,
          mediaType,
          format,
          maxBytes,
          workBytes,
          async generate(signal) {
            signal.throwIfAborted();
            return encodeInput ? encodeInput() : fixed;
          },
        } satisfies PreparedResource;
      },
      selector.kind === 'atlas' ? 2 : 1,
    );
    if (!result) return null;
    const entry: PublicationEntry = { selector, artifact: result.artifact, actionKey: result.actionKey, ...extra };
    this.generationLeases.set(entry, result.release);
    if (selector.kind === 'atlas') {
      const atlasData = JSON.parse(new TextDecoder().decode(repo.open(result.artifact))) as AtlasDocument;
      entry.image = parseArtifactRef(atlasData.image);
    }
    return entry;
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
      ...(entry.nbtHash ? { nbtHash: entry.nbtHash } : {}),
      ...(entry.terrainHash ? { terrainHash: entry.terrainHash } : {}),
      ...(entry.entityHash ? { entityHash: entry.entityHash } : {}),
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
    const view = await this.view(viewId);
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
              entry = (await this.generate(selector, view.head.generation)) ?? undefined;
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
          this.releaseGeneration(entry);
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
    const view = await this.view(viewId, true);
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
              replacement = await this.generate(entry.selector, view.head.generation);
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
            if (replacement) this.releaseGeneration(replacement);
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
    const view = await this.view(viewId);
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
      const normalized = [...new Set(ids)].sort();
      textureSetId = sha256(canonicalJson(normalized));
      for (const [key, value] of this.textureSets)
        if (value.until < Date.now()) {
          value.release();
          this.textureSets.delete(key);
        }
      if (!this.textureSets.has(textureSetId))
        this.textureSets.set(textureSetId, {
          ids: normalized,
          until: Date.now() + this.config.resources.work.handoffMs,
          release: this.memberMetadata.reserve(1024 + bytesJson(normalized).byteLength * 4),
        });
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
    if (this.config.resources.delivery.mode === 'server') return this.dynamic!.worldStore.listWorlds();
    const view = await this.view((await this.head()).viewId);
    return view.publication!.worlds;
  }
  private async projection<T>(world: string, viewId: string | undefined, read: (view: View) => Promise<T>): Promise<T> {
    const id = viewId ?? (await this.head(world)).viewId;
    const run = async () => {
      const view = await this.view(id);
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
        this.state.requiresSourceSnapshot = true;
        if (this.store && this.config.resources.roles.includes('publish'))
          await this.store.pending('pending', undefined, true);
      }
      try {
        const result = await operation();
        if (domain === 'content') {
          this.state.publication = 'pending';
          if (this.store && this.config.resources.roles.includes('publish')) {
            try {
              await this.store.pending('pending', undefined, this.state.requiresSourceSnapshot);
            } catch {
              this.state.error = 'RESOURCE_BACKEND_UNAVAILABLE';
            }
          }
          this.schedulePublication();
        }
        return result;
      } finally {
        if (domain === 'source') this.invalidate();
      }
    });
  }
  private async publishEntry(entry: PublicationEntry, token: SnapshotToken) {
    if (!this.target) throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'publication target is not configured');
    let restored: PublicationEntry | null | undefined;
    try {
      if (
        entry.selector.kind !== 'overlay-media' &&
        (!this.repo().lease(entry.artifact) || (entry.image && !this.repo().lease(entry.image)))
      ) {
        restored = await this.generate(entry.selector, this.coordinator.generation, token);
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
        const media = await this.content!.openPublicMedia(s.mapId, s.dimension, s.assetId, s.versionId);
        const lease = await media.read();
        try {
          await this.target.ensure(entry.artifact, lease.bytes);
          const release = this.repo().work.reserve(entry.artifact.bytes);
          try {
            await this.target.verify(entry.artifact);
          } finally {
            release();
          }
        } finally {
          lease.release();
        }
        return;
      }
      for (const ref of refs) {
        const lease = await this.repo().acquire(ref, false);
        try {
          await this.target.ensure(ref, lease.bytes);
          const release = this.repo().work.reserve(ref.bytes);
          try {
            await this.target.verify(ref);
          } finally {
            release();
          }
        } finally {
          lease.release();
        }
      }
    } finally {
      this.releaseGeneration(entry);
      if (restored) this.releaseGeneration(restored);
    }
  }
  async publish(expectedHead?: string | null): Promise<import('@violet-map/core/resources').PublicationHead> {
    return (await this.buildPublication(expectedHead, false)) as import('@violet-map/core/resources').PublicationHead;
  }
  async prepare(): Promise<PublicationManifest> {
    return (await this.buildPublication(undefined, true)) as PublicationManifest;
  }
  private releaseGeneration(entry: PublicationEntry) {
    this.generationLeases.get(entry)?.();
    this.generationLeases.delete(entry);
  }
  private discardPreparedBytes(entry: PublicationEntry) {
    this.releaseGeneration(entry);
    for (const ref of [entry.artifact, ...(entry.image ? [entry.image] : [])])
      this.repo().handoff.releaseUnclaimed(ref.digest);
  }
  private async buildPublication(expectedHead: string | null | undefined, prepareOnly: boolean) {
    if (!this.config.resources.roles.includes('publish') || !this.store || !this.target || !this.dynamic)
      throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'publish role is disabled');
    if (this.config.resources.source.consistency !== 'snapshot')
      throw new ResourceError('SOURCE_SNAPSHOT_CHANGED', 'publications require a controlled snapshot source');
    return this.sourceGate.write((token) =>
      this.operations.run('publication', async () => {
        const started = Date.now();
        this.state.publication = 'pending';
        this.state.error = undefined;
        const previous = await this.store!.head();
        const expected = expectedHead === undefined ? (previous?.publicationId ?? null) : expectedHead;
        if ((previous?.publicationId ?? null) !== expected)
          throw new ResourceError('PUBLICATION_CONFLICT', 'expected publication head changed');
        this.previousPublication = previous ? await this.store!.manifest(previous) : undefined;
        const generation = this.coordinator.generation;
        try {
          const root = await this.renderRoot(token);
          const worlds = await this.dynamic!.worldStore.listWorlds();
          const manifest: PublicationManifest = {
            schemaVersion: 1,
            sourceScope: await this.sourceScope(),
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
          const metadata = new ByteBudget(Math.floor(this.config.resources.cache.metadataBytes / 4));
          const track = (value: unknown) => metadata.reserve(256 + bytesJson(value).byteLength * 4);
          track(manifest);
          for (const entry of root.entries) {
            if (prepareOnly) this.discardPreparedBytes(entry);
            else await this.publishEntry(entry, token);
          }
          for (const id of await this.dynamic!.assets.textureIds()) {
            if (manifest.entries.some((e) => e.selector.kind === 'texture' && e.selector.id === id)) continue;
            const selector: ResourceSelector = { kind: 'texture', id };
            const old = this.previousPublication?.entries.find(
              (e) => selectorKey(e.selector) === selectorKey(selector),
            );
            if (old) await this.repo().rememberAction(old.actionKey, old.artifact);
            const entry = await this.generate(selector, generation, token);
            if (entry) {
              if (prepareOnly) this.discardPreparedBytes(entry);
              else await this.publishEntry(entry, token);
              track(entry);
              manifest.entries.push(entry);
            }
          }
          for (const world of worlds) {
            manifest.sourceScopes[world.id] = await this.sourceScope(world.id);
            const identity = await this.mounts.worlds!.read(`${world.id}/.violet-map/identity.json`);
            if (identity) {
              const value = JSON.parse(new TextDecoder().decode(identity));
              if (value.schema !== 1 || typeof value.id !== 'string')
                throw new ResourceError('SOURCE_REVISION_UNAVAILABLE', 'invalid archive identity');
              manifest.archiveIds[world.id] = value.id;
            }
            for (const dimension of world.dimensions) {
              const coverage = await this.dynamic!.worldStore.listChunkSourceCoverage(world.id, dimension);
              if (bytesJson(coverage).byteLength * 4 > this.config.resources.cache.metadataBytes / 4)
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
                const oldPage = oldRegion ? await this.store!.page(oldRegion.artifact) : undefined;
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
                  const entry = await this.generate(selector, generation, token);
                  if (entry) {
                    if (prepareOnly) this.discardPreparedBytes(entry);
                    else await this.publishEntry(entry, token);
                    chunks.push(entry);
                  }
                }
                const page = regionPage(world.id, dimension, rx, rz, chunks);
                if (!prepareOnly) await this.store!.ensureIndex(page.artifact, page.bytes);
                const region = { world: world.id, dimension, rx, rz, artifact: page.artifact };
                track(region);
                manifest.regions.push(region);
              }
              const topData = (await this.dynamic!.topMap.getTopMapManifest(world.id))?.dimensions[dimension];
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
                  const entry = await this.generate(selector, generation, token);
                  if (!entry) throw new ResourceError('TOPMAP_REBAKE_REQUIRED', 'baked tile is missing');
                  if (prepareOnly) this.discardPreparedBytes(entry);
                  else await this.publishEntry(entry, token);
                  track(entry);
                  manifest.entries.push(entry);
                }
              }
            }
          }
          if (this.content)
            for (const map of await this.content.listMaps())
              for (const dimension of [
                ...new Set(map.bindings.filter((b) => b.enabled).map((b) => b.dimension)),
              ].sort()) {
                const snapshot = await this.content.snapshot(map.mapId, dimension);
                track(snapshot);
                manifest.overlays.push(snapshot);
                const bindingWorld = worlds.find((w) => w.id === map.worldKey);
                if (bindingWorld) bindingWorld.mapIds = [...new Set([...(bindingWorld.mapIds ?? []), map.mapId])];
                for (const version of snapshot.media) {
                  const entry = await this.generate(
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
          const verify = async () => {
            for (const entry of manifest.entries)
              for (const ref of [entry.artifact, ...(entry.image ? [entry.image] : [])])
                if (!(await this.target!.exists(ref)))
                  throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'publication closure contains a missing object');
            for (const region of manifest.regions) {
              const page = await this.store!.page(region.artifact);
              for (const entry of page.chunks)
                if (!(await this.target!.exists(entry.artifact)))
                  throw new ResourceError(
                    'RESOURCE_NOT_PUBLISHED',
                    'publication region closure contains a missing object',
                  );
            }
          };
          const head = await this.store!.commit(
            manifest,
            expected,
            async () => {
              this.coordinator.assert(generation);
            },
            verify,
          );
          try {
            await this.store!.clearPending();
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
          for (const entry of this.root?.entries ?? []) this.discardPreparedBytes(entry);
        }
      }),
    );
  }
  private async verifyManifest(manifest: PublicationManifest) {
    if (!this.store || !this.target)
      throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'publication target is not configured');
    let objects = 0;
    const verify = async (ref: ArtifactRef) => {
      const release = this.repository?.work.reserve(ref.bytes);
      try {
        await this.target!.verify(ref);
        objects++;
      } finally {
        release?.();
      }
    };
    for (const entry of manifest.entries) {
      await verify(entry.artifact);
      if (entry.image) await verify(entry.image);
    }
    for (const region of manifest.regions)
      for (const entry of (await this.store.page(region.artifact)).chunks) await verify(entry.artifact);
    return { objects };
  }
  async verify() {
    const head = await this.store?.head();
    if (!head) throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'no publication exists');
    return { publicationId: head.publicationId, ...(await this.verifyManifest(await this.store!.manifest(head))) };
  }
  async reindex() {
    const head = await this.store?.head();
    if (!head) return 0;
    if (!this.repository)
      throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'select an explicit action index to reindex');
    const manifest = await this.store!.manifest(head);
    let actions = 0;
    const record = async (entry: PublicationEntry) => {
      if (!(await this.target?.exists(entry.artifact)))
        throw new ResourceError('RESOURCE_BACKEND_UNAVAILABLE', 'reindex requires the complete authoritative closure');
      await this.repository!.rememberAction(entry.actionKey, entry.artifact);
      actions++;
    };
    for (const entry of manifest.entries) await record(entry);
    for (const region of manifest.regions)
      for (const entry of (await this.store!.page(region.artifact)).chunks) await record(entry);
    return actions;
  }
  async recover(quiesced: boolean) {
    if (!quiesced) throw new TypeError('recovery requires explicit confirmation that all other writers are stopped');
    if (!this.store || !this.config.resources.roles.includes('publish'))
      throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'publish role is disabled');
    return this.sourceGate.write(async () => {
      await this.store!.recoverQuiesced();
      return this.store!.recoverPrepared(async (manifest) => {
        await this.verifyManifest(manifest);
      });
    });
  }
  async gc() {
    if (!this.store || !this.target || !this.config.resources.roles.includes('publish'))
      throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'publish role is disabled');
    return this.sourceGate.write(() =>
      collectPublicationGarbage(this.store!, this.target!, {
        metadataBytes: this.config.resources.cache.metadataBytes,
        retainedMs: this.config.resources.publication.retainedMs,
      }),
    );
  }
  async status() {
    return {
      ...this.state,
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
