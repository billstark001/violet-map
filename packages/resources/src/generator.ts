import { collectTextureIds } from '@violet-map/core/assets';
import type { AtlasDocument } from '@violet-map/core/contracts';
import {
  canonicalJson,
  mediaArtifact,
  parseArtifactRef,
  ResourceError,
  type PublicationEntry,
  type ResourceSelector,
  type ArtifactRef,
} from '@violet-map/core/resources';
import { sha256 } from '@violet-map/storage';
import type { BlobRepository, PreparedResource } from './blobRepository.js';
import type { ContentSource, DynamicSources } from './engineTypes.js';
import { resourceJsonBytes } from './engineSupport.js';
import { actionKey } from './keys.js';
import { selectorKey } from './publication.js';
import { type Singleflight } from './singleflight.js';
import { type SnapshotGate, type SnapshotToken } from './snapshotGate.js';
import { type ByteBudget } from './budget.js';

export interface GenerationInputs {
  bundle?: ArtifactRef;
  blocks?: ArtifactRef;
}

/** Owns generation inputs, temporary output leases and explicit atlas sets. */
export class ResourceGenerator {
  private readonly textureSets = new Map<string, { ids: string[]; until: number; release(): void }>();
  private readonly generationLeases = new WeakMap<PublicationEntry, () => void>();
  constructor(
    private readonly repository: BlobRepository | undefined,
    private readonly dynamic: DynamicSources | undefined,
    private readonly content: ContentSource | undefined,
    private readonly sourceGate: SnapshotGate,
    private readonly operations: Singleflight,
    private readonly metadata: ByteBudget,
  ) {}
  private repo() {
    if (!this.repository) throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'dynamic resource generation is disabled');
    return this.repository;
  }
  registerTextureSet(ids: string[], lifetimeMs: number) {
    const normalized = [...new Set(ids)].sort();
    const id = sha256(canonicalJson(normalized));
    for (const [key, value] of this.textureSets)
      if (value.until < Date.now()) {
        value.release();
        this.textureSets.delete(key);
      }
    const known = this.textureSets.get(id);
    if (known) known.until = Date.now() + lifetimeMs;
    else
      this.textureSets.set(id, {
        ids: normalized,
        until: Date.now() + lifetimeMs,
        release: this.metadata.reserve(1024 + resourceJsonBytes(normalized).byteLength * 4),
      });
    return id;
  }
  close() {
    for (const value of this.textureSets.values()) value.release();
    this.textureSets.clear();
  }
  async generate(
    selector: ResourceSelector,
    generation: number,
    token?: SnapshotToken,
    signal?: AbortSignal,
    inputs?: GenerationInputs,
  ): Promise<PublicationEntry | null> {
    if (token)
      return this.sourceGate.read(
        (snapshot) =>
          this.operations.run(
            'snapshot-generate:' + token.id + ':' + generation + selectorKey(selector),
            (taskSignal) => this.generateSnapshot(selector, generation, snapshot, taskSignal, inputs),
            signal,
            {
              acquire: (entry) => this.retain(entry),
              release: (entry) => {
                if (entry) this.release(entry);
              },
            },
          ),
        token,
        signal,
      );
    return this.operations.run(
      'generate:' + generation + selectorKey(selector),
      (taskSignal) =>
        this.sourceGate.read(
          (snapshot) => this.generateSnapshot(selector, generation, snapshot, taskSignal, inputs),
          undefined,
          taskSignal,
        ),
      signal,
      {
        acquire: (entry) => this.retain(entry),
        release: (entry) => {
          if (entry) this.release(entry);
        },
      },
    );
  }

  private async generateSnapshot(
    selector: ResourceSelector,
    generation: number,
    _token: SnapshotToken,
    signal: AbortSignal,
    inputs?: GenerationInputs,
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
    // Chunk input uses bounded sector spans, not two complete region files.
    // 64 MiB covers compressed input, owned NBT and MessagePack/output copies.
    const workBytes = ['atlas', 'top-map-tile'].includes(selector.kind) ? 128 * 1024 ** 2 : 64 * 1024 ** 2;
    const result = await repo.build(
      selectorKey(selector),
      generation,
      maxBytes,
      workBytes,
      async (prepareSignal) => {
        prepareSignal.throwIfAborted();
        if (selector.kind === 'atlas') {
          const supplied = this.textureSets.get(selector.textureSetId);
          if (selector.textureSetId !== 'default' && !supplied)
            throw new ResourceError('RESOURCE_VIEW_EXPIRED', 'explicit atlas texture set expired', true);
          const bundle = inputs?.bundle
            ? (JSON.parse(
                new TextDecoder().decode(repo.open(inputs.bundle)),
              ) as import('@violet-map/core/assets').AssetBundle)
            : await dynamic.assets.buildAssetBundle();
          const blocks = inputs?.blocks
            ? (JSON.parse(
                new TextDecoder().decode(repo.open(inputs.blocks)),
              ) as import('@violet-map/core/assets').BlockInfoMap)
            : await dynamic.gameData.buildBlockInfo();
          const prepared = await dynamic.assets.prepareTextureAtlas(
            supplied?.ids ?? collectTextureIds(bundle, blocks),
            bundle,
          );
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
              const bytes = resourceJsonBytes(result.manifest);
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
          const chunk =
            (
              await dynamic.worldStore.readChunks(selector.world, selector.dimension, [
                { cx: selector.cx, cz: selector.cz },
              ])
            )[0] ?? null;
          if (!chunk) return null;
          if (chunk.data.byteLength + (chunk.entities?.byteLength ?? 0) > Math.max(0, maxBytes - 96))
            throw new ResourceError('RESOURCE_BUSY', 'chunk cannot fit the declared MessagePack output budget');
          const { prepareChunkArtifact } = await import('./chunkArtifact.js');
          const prepared = prepareChunkArtifact(
            {
              cx: selector.cx,
              cz: selector.cz,
              data: chunk.data,
              ...(chunk.entities ? { entities: chunk.entities } : {}),
            },
            chunk,
          );
          dependencies = prepared.dependencies;
          extra = {
            terrainDigest: prepared.terrainDigest,
            contentDigest: prepared.contentDigest,
            ...(prepared.entityDigest ? { entityDigest: prepared.entityDigest } : {}),
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
          input = resourceJsonBytes(await dynamic.assets.buildAssetBundle());
          format = 'asset-bundle-json-v1';
          mediaType = 'application/json';
        } else if (selector.kind === 'game-data') {
          const value =
            selector.name === 'blocks'
              ? await dynamic.gameData.buildBlockInfo()
              : selector.name === 'biomes'
                ? await dynamic.gameData.readBiomes()
                : await dynamic.gameData.readDimensions();
          input = resourceJsonBytes(value);
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
      signal,
    );
    if (!result) return null;
    const entry: PublicationEntry = { selector, artifact: result.artifact, actionKey: result.actionKey, ...extra };
    try {
      if (selector.kind === 'atlas') {
        const atlasData = JSON.parse(new TextDecoder().decode(repo.open(result.artifact))) as AtlasDocument;
        entry.image = parseArtifactRef(atlasData.image);
      }
      signal.throwIfAborted();
      this.generationLeases.set(entry, result.release);
      return entry;
    } catch (error) {
      result.release();
      throw error;
    }
  }

  private retain(entry: PublicationEntry | null): PublicationEntry | null {
    if (!entry) return null;
    const copy = { ...entry };
    if (entry.selector.kind !== 'overlay-media') {
      const held = this.repo().hold([entry.artifact, ...(entry.image ? [entry.image] : [])]);
      this.generationLeases.set(copy, held.release);
    }
    return copy;
  }

  release(entry: PublicationEntry) {
    this.generationLeases.get(entry)?.();
    this.generationLeases.delete(entry);
  }

  discard(entry: PublicationEntry) {
    this.release(entry);
    for (const ref of [entry.artifact, ...(entry.image ? [entry.image] : [])])
      this.repo().handoff.releaseUnclaimed(ref.digest);
  }
}
