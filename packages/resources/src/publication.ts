import { isWorldName, isDimensionId } from '@violet-map/core/domain';
import { parseOverlaySnapshot } from '@violet-map/core/overlays';
import { ByteBudget } from './budget.js';
import { Singleflight } from './singleflight.js';
import {
  canonicalJson,
  parseArtifactRef,
  parseResourceSelector,
  ResourceError,
  type ArtifactRef,
  type PublicationEntry,
  type PublicationHead,
  type PublicationManifest,
  type RegionResourcePage,
} from '@violet-map/core/resources';
import type { AtomicObjectStorage, ObjectReader } from '@violet-map/core/storage';
import {
  artifactRef,
  ContentAddressedStorage,
  type ConditionalDocumentStore,
  type ConditionalObjectWriter,
  type ObjectScanner,
} from '@violet-map/storage';
import { randomUUID } from 'node:crypto';

export type PublicationStorage = AtomicObjectStorage &
  ConditionalDocumentStore &
  ConditionalObjectWriter &
  ObjectScanner;

const json = (value: unknown) => new TextEncoder().encode(canonicalJson(value));

export function selectorKey(selector: import('@violet-map/core/resources').ResourceSelector): string {
  return canonicalJson(parseResourceSelector(selector));
}

function document(value: unknown, fields: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !fields.includes(k))
  )
    throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'invalid publication document');
  return value as Record<string, unknown>;
}

export function parsePublicationEntry(value: unknown): PublicationEntry {
  const v = document(value, ['selector', 'artifact', 'actionKey', 'image', 'nbtHash', 'terrainHash', 'entityHash']);
  const result: PublicationEntry = {
    selector: parseResourceSelector(v.selector),
    artifact: parseArtifactRef(v.artifact),
    actionKey: v.actionKey as string,
  };
  if (typeof v.actionKey !== 'string' || !/^[a-f0-9]{64}$/.test(v.actionKey))
    throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'invalid publication action key');
  if (v.image !== undefined) result.image = parseArtifactRef(v.image);
  if ((result.selector.kind === 'atlas') !== (result.image !== undefined))
    throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'atlas requires its image artifact');
  for (const k of ['nbtHash', 'terrainHash', 'entityHash'] as const)
    if (v[k] !== undefined) {
      if (typeof v[k] !== 'string' || !/^[a-f0-9]{64}$/.test(v[k]))
        throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'invalid chunk digest');
      result[k] = v[k];
    }
  return result;
}

export function parsePublicationManifest(value: unknown): PublicationManifest {
  const v = document(value, [
    'schemaVersion',
    'sourceScope',
    'archiveIds',
    'sourceScopes',
    'renderRoot',
    'worlds',
    'entries',
    'regions',
    'coverage',
    'topMaps',
    'overlays',
  ]);
  if (
    v.schemaVersion !== 1 ||
    typeof v.sourceScope !== 'string' ||
    !v.sourceScope ||
    typeof v.renderRoot !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.renderRoot)
  )
    throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'unsupported publication');
  if (!Array.isArray(v.entries) || !Array.isArray(v.regions) || !Array.isArray(v.worlds) || !Array.isArray(v.overlays))
    throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'invalid publication collections');
  for (const key of ['archiveIds', 'sourceScopes', 'coverage', 'topMaps'])
    if (!v[key] || typeof v[key] !== 'object' || Array.isArray(v[key]))
      throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'invalid publication projection');
  const worlds = v.worlds.map((value) => {
    const world = document(value, ['id', 'dimensions', 'mapIds']);
    if (
      !isWorldName(world.id) ||
      !Array.isArray(world.dimensions) ||
      world.dimensions.some((d) => !isDimensionId(d)) ||
      new Set(world.dimensions).size !== world.dimensions.length ||
      (world.mapIds !== undefined &&
        (!Array.isArray(world.mapIds) || world.mapIds.some((id) => typeof id !== 'string' || !id)))
    )
      throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'invalid published world');
    return world;
  });
  const scopes = v.sourceScopes as Record<string, unknown>;
  for (const world of worlds)
    if (typeof scopes[world.id as string] !== 'string' || !/^[a-f0-9]{64}$/.test(scopes[world.id as string] as string))
      throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'published world has no source scope');
  if (new Set(worlds.map((world) => world.id)).size !== worlds.length)
    throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'duplicate published world');
  const overlays = v.overlays.map(parseOverlaySnapshot);
  const entries = v.entries.map(parsePublicationEntry);
  if (new Set(entries.map((e) => selectorKey(e.selector))).size !== entries.length)
    throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'duplicate publication selector');
  const regions = v.regions.map((r) => {
    const p = document(r, ['world', 'dimension', 'rx', 'rz', 'artifact']);
    parseResourceSelector({ kind: 'top-map-tile', world: p.world, dimension: p.dimension, rx: p.rx, rz: p.rz });
    return { ...p, artifact: parseArtifactRef(p.artifact) };
  });
  // Canonical encoding rejects functions, non-finite values and ambiguous hidden representations.
  canonicalJson(v);
  return { ...v, worlds, overlays, entries, regions } as unknown as PublicationManifest;
}

export function regionPage(
  world: string,
  dimension: string,
  rx: number,
  rz: number,
  chunks: PublicationEntry[],
): { page: RegionResourcePage; artifact: ArtifactRef; bytes: Uint8Array } {
  const ordered = [...chunks].sort((a, b) => {
    const x = a.selector as Extract<typeof a.selector, { kind: 'chunk' }>;
    const y = b.selector as typeof x;
    return x.cz - y.cz || x.cx - y.cx;
  });
  for (const entry of ordered) {
    const s = entry.selector;
    if (
      s.kind !== 'chunk' ||
      s.world !== world ||
      s.dimension !== dimension ||
      Math.floor(s.cx / 32) !== rx ||
      Math.floor(s.cz / 32) !== rz
    )
      throw new TypeError('chunk outside region page');
  }
  if (ordered.length > 1024 || new Set(ordered.map((e) => selectorKey(e.selector))).size !== ordered.length)
    throw new TypeError('duplicate or oversized region page');
  const page: RegionResourcePage = { schemaVersion: 1, world, dimension, rx, rz, chunks: ordered };
  const bytes = json(page);
  return { page, bytes, artifact: artifactRef(bytes, 'application/json', 'region-index-v1') };
}

/** Authority is the remote/local head and immutable manifests, independent from every cache. */
export class PublicationStore {
  private readonly cas: ContentAddressedStorage;
  private readonly reads = new Singleflight(8);
  private readonly readBudget: ByteBudget;
  private owner?: { id: string; token: string; epoch: number };
  private acquiring?: Promise<void>;
  readonly metrics = { controlPut: 0, objectPut: 0, uploadedBytes: 0, cleanupFailed: 0 };
  constructor(
    private readonly reader: ObjectReader & Pick<ConditionalDocumentStore, 'readDocument'>,
    private readonly writer?: PublicationStorage,
    readonly maxDocumentBytes = 8 * 1024 ** 2,
    readWork = new ByteBudget(128 * 1024 ** 2),
  ) {
    this.cas = new ContentAddressedStorage(reader, writer);
    this.readBudget = readWork;
  }
  async head(): Promise<PublicationHead | null> {
    const raw = await this.reader.readDocument('heads/current.json', 4096);
    if (!raw) return null;
    if (raw.bytes.byteLength > 4096)
      throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'publication head exceeds limits');
    const h = document(JSON.parse(new TextDecoder().decode(raw.bytes)), [
      'schemaVersion',
      'publicationId',
      'revision',
      'manifest',
    ]);
    const manifest = parseArtifactRef(h.manifest);
    if (
      h.schemaVersion !== 1 ||
      h.publicationId !== manifest.digest ||
      !Number.isSafeInteger(h.revision) ||
      (h.revision as number) < 1 ||
      manifest.format !== 'publication-v1'
    )
      throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'invalid publication head');
    return { schemaVersion: 1, publicationId: manifest.digest, revision: h.revision as number, manifest };
  }
  async manifest(head: PublicationHead): Promise<PublicationManifest> {
    return this.reads.run('manifest:' + head.publicationId, async () => {
      const release = this.readBudget.reserve(head.manifest.bytes * 4);
      try {
        return await this.readManifest(head);
      } finally {
        release();
      }
    });
  }
  private async readManifest(head: PublicationHead): Promise<PublicationManifest> {
    if (head.manifest.bytes > this.maxDocumentBytes)
      throw new ResourceError('RESOURCE_BUSY', 'publication manifest exceeds metadata budget');
    const bytes = await this.cas.read(head.manifest, `manifests/${head.publicationId}.json`);
    if (!bytes)
      throw new ResourceError('RESOURCE_BACKEND_UNAVAILABLE', 'committed publication manifest is missing', true);
    return parsePublicationManifest(JSON.parse(new TextDecoder().decode(bytes)));
  }
  async page(ref: ArtifactRef): Promise<RegionResourcePage> {
    return this.reads.run('page:' + ref.digest, async () => {
      const release = this.readBudget.reserve(ref.bytes * 4);
      try {
        return await this.readPage(ref);
      } finally {
        release();
      }
    });
  }
  private async readPage(ref: ArtifactRef): Promise<RegionResourcePage> {
    if (ref.format !== 'region-index-v1' || ref.bytes > this.maxDocumentBytes)
      throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'invalid region page');
    const bytes = await this.cas.read(ref, `indexes/${ref.digest}.json`);
    if (!bytes) throw new ResourceError('RESOURCE_BACKEND_UNAVAILABLE', 'committed region page is missing', true);
    const v = document(JSON.parse(new TextDecoder().decode(bytes)), [
      'schemaVersion',
      'world',
      'dimension',
      'rx',
      'rz',
      'chunks',
    ]);
    if (v.schemaVersion !== 1 || !Array.isArray(v.chunks))
      throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'invalid region page');
    return regionPage(
      v.world as string,
      v.dimension as string,
      v.rx as number,
      v.rz as number,
      v.chunks.map(parsePublicationEntry),
    ).page;
  }
  /** No expiring distributed lease: a crashed owner is recovered only with explicit quiescence. */
  async acquire(): Promise<void> {
    if (this.owner) return;
    if (this.acquiring) return this.acquiring;
    if (!this.writer) throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'publication store is read-only');
    const acquire = (async () => {
      const current = await this.reader.readDocument('writer.json', 4096);
      const previous = current
        ? document(JSON.parse(new TextDecoder().decode(current.bytes)), ['owner', 'epoch'])
        : { owner: null, epoch: 0 };
      if (previous.owner !== null)
        throw new ResourceError('PUBLICATION_CONFLICT', 'another publication writer owns this store');
      const owner = { id: randomUUID(), epoch: Number(previous.epoch) + 1 };
      const bytes = json({ owner: owner.id, epoch: owner.epoch });
      if (!(await this.writer!.compareExchange('writer.json', current?.token ?? null, bytes)))
        throw new ResourceError('PUBLICATION_CONFLICT', 'publication writer changed');
      const committed = await this.reader.readDocument('writer.json', 4096);
      if (!committed) throw new ResourceError('RESOURCE_BACKEND_UNAVAILABLE', 'writer record disappeared', true);
      this.owner = { ...owner, token: committed.token };
      this.metrics.controlPut++;
    })();
    this.acquiring = acquire;
    try {
      await acquire;
    } finally {
      this.acquiring = undefined;
    }
  }
  async recoverQuiesced(): Promise<void> {
    if (!this.writer) throw new Error('publication recovery requires publish role');
    const current = await this.reader.readDocument('writer.json', 4096);
    if (!current) return;
    const value = document(JSON.parse(new TextDecoder().decode(current.bytes)), ['owner', 'epoch']);
    if (
      !(await this.writer.compareExchange(
        'writer.json',
        current.token,
        json({ owner: null, epoch: Number(value.epoch) + 1 }),
      ))
    )
      throw new ResourceError('PUBLICATION_CONFLICT', 'writer changed during recovery');
    this.metrics.controlPut++;
  }
  async assertWriter() {
    if (!this.owner) throw new ResourceError('PUBLICATION_CONFLICT', 'publication writer is not acquired');
    const record = await this.reader.readDocument('writer.json', 4096);
    if (record?.token !== this.owner.token)
      throw new ResourceError('PUBLICATION_CONFLICT', 'publication writer ownership changed');
  }
  async ensureIndex(ref: ArtifactRef, bytes: Uint8Array): Promise<void> {
    const key = `indexes/${ref.digest}.json`;
    if (await this.reader.stat(key)) {
      await this.cas.read(ref, key);
      return;
    }
    await this.acquire();
    await this.assertWriter();
    if (await this.cas.ensure(ref, bytes, key)) {
      this.metrics.controlPut++;
      this.metrics.uploadedBytes += bytes.byteLength;
    }
  }
  async commit(
    input: PublicationManifest,
    expectedHead: string | null,
    validate: () => Promise<void>,
    verifyClosure: () => Promise<void>,
  ): Promise<PublicationHead> {
    if (!this.writer) throw new Error('publication commit requires publish role');
    const manifest = parsePublicationManifest(input);
    const bytes = json(manifest);
    if (bytes.byteLength > this.maxDocumentBytes)
      throw new ResourceError('RESOURCE_BUSY', 'publication manifest exceeds metadata budget');
    const ref = artifactRef(bytes, 'application/json', 'publication-v1');
    const previous = await this.head();
    if ((previous?.publicationId ?? null) !== expectedHead)
      throw new ResourceError('PUBLICATION_CONFLICT', 'expected publication head changed');
    await validate();
    await verifyClosure();
    if (previous?.publicationId === ref.digest) return previous;
    await this.acquire();
    await this.assertWriter();
    const prepared = { schemaVersion: 1, manifest: ref, input: manifest, expectedHead, createdAt: Date.now() };
    await this.writer.replace(`prepared/${ref.digest}.json`, json(prepared), 'application/json');
    this.metrics.controlPut++;
    if (await this.cas.ensure(ref, bytes, `manifests/${ref.digest}.json`)) {
      this.metrics.controlPut++;
      this.metrics.uploadedBytes += bytes.byteLength;
    }
    await validate();
    await verifyClosure();
    await this.assertWriter();
    const current = await this.reader.readDocument('heads/current.json', 4096);
    const latest = await this.head();
    if ((latest?.publicationId ?? null) !== expectedHead)
      throw new ResourceError('PUBLICATION_CONFLICT', 'publication head changed before commit');
    if (latest) {
      const oldFile = await this.reader.read(`retained/${latest.publicationId}.json`);
      const old = oldFile
        ? JSON.parse(new TextDecoder().decode(oldFile))
        : { schemaVersion: 1, head: latest, committedAt: Date.now() };
      await this.writer.replace(
        `retained/${latest.publicationId}.json`,
        json({ ...old, retiredAt: Date.now() }),
        'application/json',
      );
      this.metrics.controlPut++;
    }
    const head: PublicationHead = {
      schemaVersion: 1,
      publicationId: ref.digest,
      revision: (latest?.revision ?? 0) + 1,
      manifest: ref,
    };
    // Retention is authoritative and precedes visibility, including crash recovery.
    await this.writer.replace(
      `retained/${ref.digest}.json`,
      json({ schemaVersion: 1, head, committedAt: Date.now() }),
      'application/json',
    );
    this.metrics.controlPut++;
    if (!(await this.writer.compareExchange('heads/current.json', current?.token ?? null, json(head))))
      throw new ResourceError('PUBLICATION_CONFLICT', 'publication head compare/exchange failed');
    this.metrics.controlPut++;
    try {
      await this.writer.delete(`prepared/${ref.digest}.json`);
    } catch {
      this.metrics.cleanupFailed++;
    } // Head already committed; the durable prepared root is safe to recover.

    return head;
  }
  async pending(state: 'pending' | 'failed', error?: string, requiresSourceSnapshot = false) {
    await this.acquire();
    await this.assertWriter();
    await this.writer!.replace(
      'pending/current.json',
      json({ schemaVersion: 1, state, requiresSourceSnapshot, ...(error ? { error } : {}), updatedAt: Date.now() }),
      'application/json',
    );
    this.metrics.controlPut++;
  }
  async clearPending() {
    if (!(await this.reader.stat('pending/current.json'))) return;
    await this.assertWriter();
    await this.writer!.delete('pending/current.json');
  }
  async publicationState() {
    const bytes = await this.reader.readRange('pending/current.json', 0, 4097);
    if (!bytes) return null;
    if (bytes.length > 4096)
      throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'invalid pending publication record');
    const record = JSON.parse(new TextDecoder().decode(bytes));
    if (
      record.schemaVersion !== 1 ||
      !['pending', 'failed'].includes(record.state) ||
      !Number.isSafeInteger(record.updatedAt)
    )
      throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'invalid pending publication state');
    return record;
  }
  async retainedHead(id: string): Promise<PublicationHead | null> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new TypeError('invalid publication ID');
    const current = await this.head();
    if (current?.publicationId === id) return current;
    const raw = await this.reader.read(`retained/${id}.json`);
    if (!raw) return null;
    if (raw.byteLength > 4096) throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'invalid retained head');
    const record = JSON.parse(new TextDecoder().decode(raw));
    if (
      record.schemaVersion !== 1 ||
      record.head?.publicationId !== id ||
      parseArtifactRef(record.head.manifest).digest !== id
    )
      throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'invalid retained head');
    if (record.retiredAt !== undefined && Date.now() - record.retiredAt > 604800000) return null;
    return record.head;
  }
  async pin(name: string, id: string): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name)) throw new TypeError('invalid backup pin name');
    const head = await this.retainedHead(id);
    if (!head) throw new ResourceError('RESOURCE_VIEW_EXPIRED', 'publication retention expired');
    await this.acquire();
    await this.assertWriter();
    await this.writer!.replace(`pins/${name}.json`, json({ schemaVersion: 1, head }), 'application/json');
    this.metrics.controlPut++;
  }
  async unpin(name: string): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name)) throw new TypeError('invalid backup pin name');
    await this.acquire();
    await this.assertWriter();
    await this.writer!.delete(`pins/${name}.json`);
  }
  /** Only a quiesced publisher may replay a prepared closure. Verification precedes the head change. */
  async recoverPrepared(verify: (manifest: PublicationManifest) => Promise<void>) {
    await this.acquire();
    await this.assertWriter();
    let committed = 0,
      cleaned = 0;
    for await (const item of this.writer!.scan('prepared')) {
      if (item.size > this.maxDocumentBytes * 2 + 4096)
        throw new ResourceError('RESOURCE_BUSY', 'prepared record exceeds budget');
      const raw = await this.reader.read(item.path);
      if (!raw) throw new Error('prepared record disappeared');
      const record = JSON.parse(new TextDecoder().decode(raw));
      if (record.schemaVersion !== 1)
        throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'unsupported prepared record');
      const manifest = parsePublicationManifest(record.input);
      const ref = artifactRef(json(manifest), 'application/json', 'publication-v1');
      if (ref.digest !== parseArtifactRef(record.manifest).digest)
        throw new ResourceError('RESOURCE_INTEGRITY_FAILED', 'prepared manifest mismatch');
      const head = await this.head();
      if (head?.publicationId === ref.digest) {
        await verify(manifest);
        await this.writer!.delete(item.path);
        cleaned++;
        continue;
      }
      if ((head?.publicationId ?? null) !== record.expectedHead)
        throw new ResourceError('PUBLICATION_CONFLICT', 'prepared publication parent changed');
      await this.commit(
        manifest,
        record.expectedHead,
        async () => {
          await this.assertWriter();
        },
        () => verify(manifest),
      );
      committed++;
    }
    return { committed, cleaned };
  }
  async *roots(
    retainedMs: number,
    orphanMs: number,
  ): AsyncIterable<{ ref: ArtifactRef; manifest: PublicationManifest }> {
    if (!this.writer) throw new Error('GC requires publish role');
    const current = await this.head();
    if (current) yield { ref: current.manifest, manifest: await this.manifest(current) };
    for (const prefix of ['retained', 'prepared', 'pins'])
      for await (const item of this.writer.scan(prefix)) {
        if (item.size > this.maxDocumentBytes * 2 + 4096)
          throw new ResourceError('RESOURCE_BUSY', 'publication control record exceeds metadata budget');
        const bytes = await this.reader.read(item.path);
        if (!bytes) throw new ResourceError('RESOURCE_BACKEND_UNAVAILABLE', 'publication root changed during GC');
        const record = JSON.parse(new TextDecoder().decode(bytes));
        if (record.schemaVersion !== 1)
          throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'unknown publication root schema');
        if (prefix === 'prepared') {
          if (!record.input)
            throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'prepared publication has no recovery closure');
          yield { ref: parseArtifactRef(record.manifest), manifest: parsePublicationManifest(record.input) };
          continue;
        }
        const head = record.head as PublicationHead;
        if (!head || head.schemaVersion !== 1 || head.publicationId !== parseArtifactRef(head.manifest).digest)
          throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'invalid retained publication head');
        if (
          prefix === 'pins' ||
          head.publicationId === current?.publicationId ||
          Date.now() - (record.retiredAt ?? record.committedAt) < (record.retiredAt ? retainedMs : orphanMs)
        )
          yield { ref: head.manifest, manifest: await this.manifest(head) };
      }
  }
  async *inventory(prefix: string) {
    if (!this.writer) throw new Error('GC requires publish role');
    yield* this.writer.scan(prefix);
  }
  async deleteControl(key: string) {
    await this.assertWriter();
    if (!this.writer || !/^((indexes|manifests)\/[a-f0-9]{64}\.json)$/.test(key))
      throw new Error('invalid control GC key');
    await this.writer.delete(key);
  }
  async close() {
    await this.reads.close();
    if (!this.owner || !this.writer) return;
    await this.assertWriter();
    if (
      !(await this.writer.compareExchange(
        'writer.json',
        this.owner.token,
        json({ owner: null, epoch: this.owner.epoch }),
      ))
    )
      throw new ResourceError('PUBLICATION_CONFLICT', 'publication writer changed before release');
    this.owner = undefined;
    this.metrics.controlPut++;
  }
}
