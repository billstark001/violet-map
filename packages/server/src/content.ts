import {
  contentId,
  ContentValidationError,
  normalizeContentDimension,
  parseBinding,
  parseLayerDocument,
  parseMapDocument,
  parseMediaDocument,
  parseMediaVersion,
  type LayerDocument,
  type MapDocument,
  type MapSourceStatus,
  type MediaDocument,
  type MediaVersion,
  type OverlaySnapshot,
} from '@violet-map/core/overlays';
import { mediaArtifact } from '@violet-map/core/resources';
import type { AtomicObjectStorage, ObjectReader } from '@violet-map/core/storage';
import type { ArtifactRead, BlobRepository } from '@violet-map/resources';
import type { ConditionalObjectWriter } from '@violet-map/storage';
import { randomUUID } from 'node:crypto';
import type { ByteRange } from './httpRange.js';

/** Published metadata with deferred blob access; ranges are inclusive and must be in bounds. */
export interface PublishedMedia {
  version: MediaVersion;
  read(range?: ByteRange): Promise<ArtifactRead>;
}

export class ContentError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 412 | 413 | 428 | 503 | 500,
    message: string,
  ) {
    super(message);
    this.name = 'ContentError';
  }
}

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

interface LayerHead {
  schemaVersion: 1;
  layerId: string;
  revision: number;
  deleted: boolean;
}

interface MediaHead {
  schemaVersion: 1;
  document: MediaDocument;
  retainedVersions: string[];
  deleted: boolean;
}

function headObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new ContentValidationError('invalid publication head');
  const object = value as Record<string, unknown>;
  if (object.schemaVersion !== 1)
    throw new ContentValidationError('unsupported publication schema', 'UNSUPPORTED_FORMAT');
  if (typeof object.deleted !== 'boolean') throw new ContentValidationError('invalid deletion marker');
  return object;
}

function parseLayerHead(value: unknown): LayerHead {
  const head = headObject(value, ['schemaVersion', 'layerId', 'revision', 'deleted']);
  contentId(head.layerId);
  if (!Number.isSafeInteger(head.revision) || (head.revision as number) < 1)
    throw new ContentValidationError('invalid published revision');
  return value as LayerHead;
}

function parseMediaHead(value: unknown): MediaHead {
  const head = headObject(value, ['schemaVersion', 'document', 'retainedVersions', 'deleted']);
  const document = parseMediaDocument(head.document);
  if (!Array.isArray(head.retainedVersions) || head.retainedVersions.length > 10000)
    throw new ContentValidationError('invalid retained versions');
  head.retainedVersions.forEach(contentId);
  if (document.versions.some((version) => !(head.retainedVersions as string[]).includes(version)))
    throw new ContentValidationError('active versions must be retained');
  return { schemaVersion: 1, document, retainedVersions: head.retainedVersions, deleted: head.deleted as boolean };
}

/** One instance owns every metadata mutation; this queue is not a distributed lock. */
export class ContentService {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly content: AtomicObjectStorage,
    private readonly blobs: AtomicObjectStorage & ConditionalObjectWriter,
    private readonly worlds: ObjectReader,
    private readonly repository: BlobRepository,
    private readonly coordinate: <T>(operation: () => Promise<T>) => Promise<T> = (operation) => operation(),
  ) {}
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(() => this.coordinate(operation));
    this.pending = next.catch(() => {});
    return next;
  }
  async drain(): Promise<void> {
    await this.pending;
  }
  private async read<T>(key: string, parse: (value: unknown) => T): Promise<T | null> {
    const bytes = await this.content.read(key);
    if (!bytes) return null;
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new ContentError('CORRUPT_CONTENT', 500, 'stored content is not valid JSON');
    }
    try {
      return parse(value);
    } catch (error) {
      if (error instanceof ContentValidationError && error.code === 'UNSUPPORTED_FORMAT') throw error;
      throw new ContentError('CORRUPT_CONTENT', 500, 'stored content failed validation');
    }
  }
  private async required<T>(key: string, parse: (value: unknown) => T, matches?: (value: T) => boolean): Promise<T> {
    const value = await this.read(key, parse);
    if (!value) throw new ContentError('CONTENT_NOT_FOUND', 404, 'content not found');
    if (matches && !matches(value))
      throw new ContentError('CORRUPT_CONTENT', 500, 'stored publication identity does not match its key');
    return value;
  }
  private match(document: { revision: number }, expected: number | undefined): void {
    if (expected === undefined) throw new ContentError('PRECONDITION_REQUIRED', 428, 'If-Match is required');
    if (document.revision !== expected) throw new ContentError('REVISION_CONFLICT', 412, 'revision is stale');
  }
  private async publishLayer(document: LayerDocument): Promise<LayerDocument> {
    await this.content.replace(
      `layers/${document.layerId}/revisions/${document.revision}.json`,
      encode(document),
      'application/json',
    );
    await this.content.replace(
      `layers/${document.layerId}/head.json`,
      encode({ schemaVersion: 1, layerId: document.layerId, revision: document.revision, deleted: false }),
      'application/json',
    );
    return document;
  }
  private async layerHeads(): Promise<LayerHead[]> {
    const files = await this.content.list('layers');
    const heads: LayerHead[] = [];
    for (const file of files) {
      const match = /^layers\/([^/]+)\/head\.json$/.exec(file.path);
      if (match) heads.push(await this.required(file.path, parseLayerHead, (head) => head.layerId === match[1]));
    }
    return heads;
  }
  async listLayers(): Promise<LayerDocument[]> {
    const result: LayerDocument[] = [];
    for (const head of await this.layerHeads()) if (!head.deleted) result.push(await this.getLayer(head.layerId));
    return result;
  }
  async getLayer(id: string, revision?: number): Promise<LayerDocument> {
    contentId(id);
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))
      throw new ContentValidationError('invalid revision');
    const head = await this.required(`layers/${id}/head.json`, parseLayerHead, (head) => head.layerId === id);
    if ((head.deleted && revision === undefined) || (revision !== undefined && revision > head.revision))
      throw new ContentError('CONTENT_NOT_FOUND', 404, 'published layer revision not found');
    const resolved = revision ?? head.revision;
    return this.required(
      `layers/${id}/revisions/${resolved}.json`,
      parseLayerDocument,
      (document) => document.layerId === id && document.revision === resolved,
    );
  }
  private async reference<T>(load: () => Promise<T>): Promise<T> {
    try {
      return await load();
    } catch (error) {
      if (error instanceof ContentError && error.code === 'CONTENT_NOT_FOUND')
        throw new ContentError('REFERENCE_CONFLICT', 409, 'referenced content does not exist');
      throw error;
    }
  }
  private async checkReferences(document: LayerDocument): Promise<void> {
    const assets = new Map<string, MediaDocument>();
    const versions = new Map<string, MediaVersion>();
    for (const feature of document.features)
      if (feature.kind === 'media') {
        let asset = assets.get(feature.assetId);
        if (!asset) {
          asset = await this.reference(() => this.getMedia(feature.assetId));
          assets.set(feature.assetId, asset);
        }
        if (!asset.versions.includes(feature.versionId))
          throw new ContentError('REFERENCE_CONFLICT', 409, 'asset version is not published');
        const key = `${feature.assetId}/${feature.versionId}`;
        let version = versions.get(key);
        if (!version) {
          version = await this.reference(() => this.getMediaVersion(feature.assetId, feature.versionId));
          versions.set(key, version);
        }
        if ((version.mediaType === 'model/gltf-binary') !== (feature.placement === 'model'))
          throw new ContentValidationError('media placement does not match asset type');
      }
  }
  createLayer(input: unknown): Promise<LayerDocument> {
    return this.mutate(async () => {
      const source = typeof input === 'object' && input ? input : {};
      const document = parseLayerDocument({ ...source, layerId: randomUUID(), revision: 1 });
      await this.checkReferences(document);
      return this.publishLayer(document);
    });
  }
  replaceLayer(id: string, input: unknown, expected?: number): Promise<LayerDocument> {
    return this.mutate(async () => {
      const current = await this.getLayer(id);
      this.match(current, expected);
      const document = parseLayerDocument(input);
      if (document.layerId !== id || document.revision !== current.revision + 1)
        throw new ContentValidationError('layer identity/revision must match the update');
      await this.checkReferences(document);
      return this.publishLayer(document);
    });
  }
  copyLayer(id: string, name?: string): Promise<LayerDocument> {
    return this.mutate(async () => {
      const source = await this.getLayer(id);
      const document = parseLayerDocument({ ...source, layerId: randomUUID(), revision: 1, name: name ?? source.name });
      await this.checkReferences(document);
      return this.publishLayer(document);
    });
  }
  deleteLayer(id: string, expected?: number): Promise<void> {
    return this.mutate(async () => {
      const current = await this.getLayer(id);
      this.match(current, expected);
      if ((await this.listMaps()).some((map) => map.bindings.some((binding) => binding.layerId === id)))
        throw new ContentError('REFERENCE_CONFLICT', 409, 'layer is bound to a map');
      await this.content.replace(
        `layers/${id}/head.json`,
        encode({ schemaVersion: 1, layerId: id, revision: current.revision, deleted: true }),
        'application/json',
      );
    });
  }
  async listMaps(): Promise<MapDocument[]> {
    const files = await this.content.list('maps');
    const result: MapDocument[] = [];
    for (const file of files) {
      const match = /^maps\/([^/]+)\.json$/.exec(file.path);
      if (match) result.push(await this.required(file.path, parseMapDocument, (map) => map.mapId === match[1]));
    }
    return result;
  }
  getMap(id: string): Promise<MapDocument> {
    contentId(id);
    return this.required(`maps/${id}.json`, parseMapDocument, (map) => map.mapId === id);
  }
  private async archiveId(worldKey: string): Promise<string | undefined> {
    const bytes = await this.worlds.read(`${worldKey}/.violet-map/identity.json`);
    if (!bytes) return undefined;
    try {
      const value = JSON.parse(new TextDecoder().decode(bytes));
      if (value.schema === 1 && typeof value.id === 'string' && value.id) return contentId(value.id);
    } catch {
      /* A malformed identity is never trusted. */
    }
    throw new ContentError('INVALID_WORLD_IDENTITY', 409, 'world identity marker is invalid');
  }
  async sourceStatus(map: MapDocument): Promise<MapSourceStatus> {
    if (map.worldKey === null) return 'unbound';
    if (!(await this.worlds.stat(`${map.worldKey}/level.dat`)) && !(await this.worlds.list(map.worldKey)).length)
      return 'missing';
    const archive = await this.archiveId(map.worldKey);
    if (map.expectedArchiveId && map.expectedArchiveId !== archive) return 'mismatch';
    return archive && map.expectedArchiveId ? 'verified' : 'unverified';
  }
  private async checkBindings(map: MapDocument): Promise<void> {
    for (const layerId of new Set(map.bindings.map((binding) => binding.layerId)))
      await this.reference(() => this.getLayer(layerId));
  }
  createMap(input: unknown): Promise<MapDocument> {
    return this.mutate(async () => {
      const source = typeof input === 'object' && input ? input : {};
      let document = parseMapDocument({ schemaVersion: 1, bindings: [], ...source, mapId: randomUUID(), revision: 1 });
      if (document.worldKey && !document.expectedArchiveId) {
        const expectedArchiveId = await this.archiveId(document.worldKey);
        if (expectedArchiveId) document = parseMapDocument({ ...document, expectedArchiveId });
      }
      await this.checkBindings(document);
      await this.content.replace(`maps/${document.mapId}.json`, encode(document), 'application/json');
      return document;
    });
  }
  replaceMap(id: string, input: unknown, expected?: number): Promise<MapDocument> {
    return this.mutate(async () => {
      const current = await this.getMap(id);
      this.match(current, expected);
      const document = parseMapDocument(input);
      if (document.mapId !== id || document.revision !== current.revision + 1)
        throw new ContentValidationError('map identity/revision must match the update');
      await this.checkBindings(document);
      await this.content.replace(`maps/${id}.json`, encode(document), 'application/json');
      return document;
    });
  }
  deleteMap(id: string, expected?: number): Promise<void> {
    return this.mutate(async () => {
      this.match(await this.getMap(id), expected);
      await this.content.delete(`maps/${id}.json`);
    });
  }
  setBinding(mapId: string, bindingId: string, input: unknown, expected?: number): Promise<MapDocument> {
    return this.mutate(async () => {
      const current = await this.getMap(mapId);
      this.match(current, expected);
      contentId(bindingId);
      const bindings = current.bindings.filter((binding) => binding.bindingId !== bindingId);
      if (input !== null) {
        const binding = parseBinding(input);
        if (binding.bindingId !== bindingId) throw new ContentValidationError('binding identity mismatch');
        await this.reference(() => this.getLayer(binding.layerId));
        bindings.push(binding);
      } else if (bindings.length === current.bindings.length)
        throw new ContentError('CONTENT_NOT_FOUND', 404, 'binding not found');
      const document = parseMapDocument({ ...current, revision: current.revision + 1, bindings });
      await this.content.replace(`maps/${mapId}.json`, encode(document), 'application/json');
      return document;
    });
  }
  private mediaHead(id: string): Promise<MediaHead> {
    contentId(id);
    return this.required(`assets/${id}/head.json`, parseMediaHead, (head) => head.document.assetId === id);
  }
  async listMedia(): Promise<MediaDocument[]> {
    const files = await this.content.list('assets');
    const result: MediaDocument[] = [];
    for (const file of files) {
      const match = /^assets\/([^/]+)\/head\.json$/.exec(file.path);
      if (match) {
        const head = await this.required(file.path, parseMediaHead, (head) => head.document.assetId === match[1]);
        if (!head.deleted) result.push(head.document);
      }
    }
    return result;
  }
  async getMedia(id: string): Promise<MediaDocument> {
    const head = await this.mediaHead(id);
    if (head.deleted) throw new ContentError('CONTENT_NOT_FOUND', 404, 'asset not found');
    return head.document;
  }
  async getMediaVersion(id: string, version: string): Promise<MediaVersion> {
    contentId(version);
    const head = await this.mediaHead(id);
    if (!head.retainedVersions.includes(version))
      throw new ContentError('CONTENT_NOT_FOUND', 404, 'published asset version not found');
    return this.required(
      `assets/${id}/versions/${version}.json`,
      parseMediaVersion,
      (document) => document.assetId === id && document.versionId === version,
    );
  }
  async importMedia(
    bytes: Uint8Array,
    type: string,
    name: string,
    id?: string,
    expected?: number,
  ): Promise<{ document: MediaDocument; version: MediaVersion }> {
    const assetId = id ?? randomUUID();
    contentId(assetId);
    // Read-only/content-disabled servers do not need native image decoders.
    const { inspectMedia } = await import('./mediaInspection.js');
    const version = await inspectMedia(assetId, bytes, type);
    const candidate = parseMediaDocument({
      schemaVersion: 1,
      assetId,
      revision: 1,
      name,
      versions: [version.versionId],
    });
    return this.mutate(async () => {
      const current = id ? await this.getMedia(id) : null;
      const previousHead = id ? await this.mediaHead(id) : null;
      if (current) this.match(current, expected);
      await this.repository.ensureOriginal(this.blobs, mediaArtifact(version), bytes);
      const document = parseMediaDocument({
        ...candidate,
        revision: current ? current.revision + 1 : 1,
        versions: [...new Set([...(current?.versions ?? []), version.versionId])],
      });
      await this.content.replace(
        `assets/${assetId}/versions/${version.versionId}.json`,
        encode(version),
        'application/json',
      );
      await this.content.replace(
        `assets/${assetId}/head.json`,
        encode({
          schemaVersion: 1,
          document,
          retainedVersions: [...new Set([...(previousHead?.retainedVersions ?? []), version.versionId])],
          deleted: false,
        }),
        'application/json',
      );
      return { document, version };
    });
  }
  deleteMedia(id: string, expected?: number, versionId?: string): Promise<void> {
    return this.mutate(async () => {
      const asset = await this.getMedia(id);
      this.match(asset, expected);
      if (versionId) contentId(versionId);
      // Only revisions committed by a head are roots; failed unpublished writes are not references.
      for (const head of await this.layerHeads())
        for (let revision = 1; revision <= head.revision; revision++) {
          const layer = await this.getLayer(head.layerId, revision);
          if (
            layer.features.some(
              (f) => f.kind === 'media' && f.assetId === id && (!versionId || f.versionId === versionId),
            )
          )
            throw new ContentError('REFERENCE_CONFLICT', 409, 'asset is referenced by a retained layer revision');
        }
      const head = await this.mediaHead(id);
      if (versionId) {
        if (!asset.versions.includes(versionId))
          throw new ContentError('CONTENT_NOT_FOUND', 404, 'asset version not found');
        const versions = asset.versions.filter((v) => v !== versionId);
        if (!versions.length)
          throw new ContentError('REFERENCE_CONFLICT', 409, 'delete the asset to remove its last version');
        await this.content.replace(
          `assets/${id}/head.json`,
          encode({ ...head, document: { ...asset, revision: asset.revision + 1, versions } }),
          'application/json',
        );
      } else
        await this.content.replace(`assets/${id}/head.json`, encode({ ...head, deleted: true }), 'application/json');
    });
  }
  async snapshot(id: string, dimension: string): Promise<OverlaySnapshot> {
    const map = await this.getMap(id);
    const dim = normalizeContentDimension(dimension);
    const sourceStatus = await this.sourceStatus(map);
    const result: OverlaySnapshot = {
      mapId: id,
      mapRevision: map.revision,
      dimension: dim,
      sourceStatus,
      layers: [],
      media: [],
    };
    if (!['verified', 'unverified'].includes(sourceStatus)) return result;
    const versions = new Map<string, MediaVersion>();
    const layers = new Map<string, LayerDocument>();
    for (const binding of map.bindings
      .filter((b) => b.enabled && b.dimension === dim)
      .sort((a, b) => a.order - b.order || a.bindingId.localeCompare(b.bindingId))) {
      let document = layers.get(binding.layerId);
      if (!document) {
        document = await this.reference(() => this.getLayer(binding.layerId));
        layers.set(binding.layerId, document);
      }
      result.layers.push({ binding, document });
      for (const f of document.features)
        if (f.kind === 'media') {
          const key = `${f.assetId}/${f.versionId}`;
          if (!versions.has(key)) versions.set(key, await this.getMediaVersion(f.assetId, f.versionId));
        }
    }
    result.media = [...versions.values()];
    return result;
  }
  /** Resolve public binding and source identity before permitting any blob access. */
  async openPublicMedia(mapId: string, dimension: string, assetId: string, versionId: string): Promise<PublishedMedia> {
    const manifest = await this.snapshot(mapId, dimension);
    if (manifest.sourceStatus === 'mismatch')
      throw new ContentError('SOURCE_MISMATCH', 409, 'world archive identity does not match');
    const item = manifest.media.find((m) => m.assetId === assetId && m.versionId === versionId);
    if (!item) throw new ContentError('CONTENT_NOT_FOUND', 404, 'resource is not bound for public display');
    return this.mediaObject(item);
  }
  /** Resolve a retained media version without reading its blob. */
  async openMedia(id: string, versionId: string): Promise<PublishedMedia> {
    return this.mediaObject(await this.getMediaVersion(id, versionId));
  }
  private async mediaObject(version: MediaVersion): Promise<PublishedMedia> {
    const stat = await this.blobs.stat(version.blob);
    if (!stat || stat.size !== version.bytes)
      throw new ContentError('BACKEND_UNAVAILABLE', 503, 'retained media original is missing or incomplete');
    return {
      version,
      read: (range) => this.repository.readObject(this.blobs, version.blob, mediaArtifact(version), range),
    };
  }
  async verifyRetainedMedia() {
    let versions = 0,
      bytes = 0;
    for (const file of await this.content.list('assets')) {
      const match = /^assets\/([^/]+)\/head\.json$/.exec(file.path);
      if (!match) continue;
      const head = await this.mediaHead(match[1]);
      for (const id of head.retainedVersions) {
        const media = await this.openMedia(match[1], id);
        const lease = await media.read();
        try {
          versions++;
          bytes += lease.bytes.byteLength;
        } finally {
          lease.release();
        }
      }
    }
    return { versions, bytes };
  }
  /** Read an entire publicly bound media version, validating its source identity first. */
  async publicMedia(mapId: string, dimension: string, assetId: string, versionId: string) {
    const media = await this.openPublicMedia(mapId, dimension, assetId, versionId);
    const read = await media.read();
    read.release();
    return { version: media.version, bytes: read.bytes };
  }
  /** Read an entire retained media version for authenticated management. */
  async readMedia(id: string, versionId: string) {
    const media = await this.openMedia(id, versionId);
    const read = await media.read();
    read.release();
    return { version: media.version, bytes: read.bytes };
  }
}
