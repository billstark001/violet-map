import { canonicalJson, parseArtifactRef, type ArtifactRef } from '@violet-map/core/resources';
import type { AtomicObjectStorage } from '@violet-map/core/storage';
import {
  ContentAddressedStorage,
  contentObjectKey,
  verifyArtifact,
  type ConditionalDocumentStore,
  type ConditionalObjectWriter,
  type ObjectScanner,
} from '@violet-map/storage';
import { randomUUID } from 'node:crypto';
import { ByteBudget } from './budget.js';
import { ResourceCache } from './cache.js';
import { assertActionKey } from './catalog.js';

/** An exclusively owned, disposable cache mount. Its inventory is streamed once at startup. */
export class PersistentResourceCache {
  private readonly catalog: ResourceCache<number>;
  private readonly removals = new Set<string>();
  private readonly cas: ContentAddressedStorage;
  private writing = false;
  private pendingKey?: string;
  private ownerToken?: string;
  private readonly owner = randomUUID();
  private readonly ownerKey = 'cache-owner.json';
  readonly writes: ByteBudget;
  readonly metrics = { put: 0, uploadedBytes: 0, writeBudgetReject: 0, admissionReject: 0 };
  constructor(
    private readonly storage: AtomicObjectStorage & ConditionalObjectWriter & ObjectScanner & ConditionalDocumentStore,
    bytes: number,
    metadataEntries: number,
    writeBytes: number,
    private readonly writable = true,
  ) {
    this.catalog = new ResourceCache(bytes, metadataEntries, (key) => this.removals.add(key));
    this.cas = new ContentAddressedStorage(storage, storage);
    this.writes = new ByteBudget(writeBytes);
  }
  get bytes() {
    return this.catalog.bytes;
  }
  private async flushRemovals() {
    if (!this.writable) {
      this.removals.clear();
      return;
    }
    for (const key of this.removals) {
      await this.storage.delete(key);
      this.removals.delete(key);
    }
  }
  async initialize() {
    if (this.writable) {
      const current = await this.storage.readDocument(this.ownerKey, 4096);
      if (current && JSON.parse(new TextDecoder().decode(current.bytes)).owner !== null)
        throw new Error('resource cache already has a writer; recover only after its owner is quiesced');
      const bytes = new TextEncoder().encode(canonicalJson({ schemaVersion: 1, owner: this.owner }));
      if (!(await this.storage.compareExchange(this.ownerKey, current?.token ?? null, bytes)))
        throw new Error('resource cache ownership conflict');
      this.ownerToken = (await this.storage.readDocument(this.ownerKey, 4096))!.token;
    }
    for await (const info of this.storage.scan()) {
      if (info.path === this.ownerKey) continue;
      if (!/^sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(info.path) && !/^actions\/[a-f0-9]{64}\.json$/.test(info.path))
        throw new Error('unexpected object in resource cache mount');
      if (!this.catalog.set(info.path, info.size, info.size)) this.removals.add(info.path);
      await this.flushRemovals();
    }
  }
  async read(ref: ArtifactRef): Promise<Uint8Array | null> {
    const key = contentObjectKey(ref.digest);
    if (key === this.pendingKey) return null;
    if (!this.catalog.capacity) return null;
    if (this.catalog.get(key) === undefined) {
      if (this.writable) return null;
      const info = await this.storage.stat(key);
      if (!info) return null;
      if (!this.catalog.set(key, info.size, info.size)) return null;
      await this.flushRemovals();
    }
    const bytes = await this.cas.read(ref);
    if (!bytes) {
      this.catalog.delete(key);
      await this.flushRemovals();
    }
    return bytes;
  }
  async action(key: string): Promise<ArtifactRef | undefined> {
    assertActionKey(key);
    const file = `actions/${key}.json`;
    if (file === this.pendingKey) return undefined;
    if (!this.catalog.capacity) return undefined;
    let size = this.catalog.get(file);
    if (size === undefined) {
      if (this.writable) return undefined;
      const info = await this.storage.stat(file);
      if (!info) return undefined;
      if (info.size > 4096) throw new Error('cached action exceeds metadata budget');
      if (!this.catalog.set(file, info.size, info.size)) return undefined;
      size = info.size;
      await this.flushRemovals();
    }
    const bytes = await this.storage.readRange(file, 0, size + 1);
    if (!bytes) {
      this.catalog.delete(file);
      await this.flushRemovals();
      return undefined;
    }
    if (bytes.byteLength !== size || size > 4096) throw new Error('invalid cached action record');
    return parseArtifactRef(JSON.parse(new TextDecoder().decode(bytes)));
  }
  /** No waiting fill queue: a saturated optional write budget is normal non-admission. */
  async retain(action: string, ref: ArtifactRef, bytes: Uint8Array): Promise<boolean> {
    assertActionKey(action);
    if (!this.writable) return false;
    verifyArtifact(ref, bytes);
    if (this.writing) {
      this.metrics.writeBudgetReject++;
      return false;
    }
    const json = new TextEncoder().encode(canonicalJson(ref));
    const release = this.writes.tryReserve(bytes.byteLength + json.byteLength);
    if (!release) {
      this.metrics.writeBudgetReject++;
      return false;
    }
    this.writing = true;
    try {
      const key = contentObjectKey(ref.digest);
      if (this.catalog.get(key) === undefined) {
        if (!this.catalog.set(key, bytes.byteLength, bytes.byteLength)) {
          this.metrics.admissionReject++;
          return false;
        }
        this.pendingKey = key;
        await this.flushRemovals();
        if (await this.cas.ensure(ref, bytes)) {
          this.metrics.put++;
          this.metrics.uploadedBytes += bytes.byteLength;
        }
        this.pendingKey = undefined;
      }
      const file = `actions/${action}.json`;
      if (this.catalog.get(file) === undefined && this.catalog.set(file, json.byteLength, json.byteLength)) {
        this.pendingKey = file;
        await this.flushRemovals();
        // The body precedes its optional action record; eviction may legitimately remove either later.
        await this.storage.replace(file, json, 'application/json');
        this.metrics.put++;
        this.metrics.uploadedBytes += json.byteLength;
        this.pendingKey = undefined;
      }
      return true;
    } catch (error) {
      if (this.pendingKey) {
        // Roll back admission, not the object: an uncertain write may have
        // completed, and corruption must remain visible to the next verifier.
        this.catalog.delete(this.pendingKey);
        this.removals.delete(this.pendingKey);
      }
      throw error;
    } finally {
      this.pendingKey = undefined;
      this.writing = false;
      release();
    }
  }
  async close() {
    if (this.ownerToken) {
      if (
        !(await this.storage.compareExchange(
          this.ownerKey,
          this.ownerToken,
          new TextEncoder().encode(canonicalJson({ schemaVersion: 1, owner: null })),
        ))
      )
        throw new Error('resource cache ownership lost');
      this.ownerToken = undefined;
    }
  }
  async resize(bytes: number) {
    this.catalog.resize(bytes);
    await this.flushRemovals();
  }
}
