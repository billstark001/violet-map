import type { ObjectStorage, StoredFileInfo } from '@violet-map/core/storage';
import type { ConditionalDocumentStore, ConditionalObjectWriter, ObjectHttpMetadata } from './capabilities.js';
import { cleanStoragePath, joinStoragePath } from './paths.js';

/** Presents a directory inside another storage as its own storage root. */
export class ScopedStorage implements ObjectStorage {
  readonly kind: ObjectStorage['kind'];
  private readonly prefix: string;
  constructor(
    private readonly storage: ObjectStorage,
    prefix = '',
  ) {
    this.kind = storage.kind;
    this.prefix = cleanStoragePath(prefix);
  }
  private path(filePath: string): string {
    return joinStoragePath(this.prefix, cleanStoragePath(filePath));
  }
  private unprefix(filePath: string): string {
    return this.prefix && filePath.startsWith(`${this.prefix}/`) ? filePath.slice(this.prefix.length + 1) : filePath;
  }
  read(filePath: string) {
    return this.storage.read(this.path(filePath));
  }
  readRange(filePath: string, start: number, length: number) {
    return this.storage.readRange(this.path(filePath), start, length);
  }
  write(filePath: string, bytes: Uint8Array, contentType?: string) {
    return this.storage.write(this.path(filePath), bytes, contentType);
  }
  async replace(filePath: string, bytes: Uint8Array, contentType?: string): Promise<void> {
    const backend = this.storage as Partial<import('@violet-map/core/storage').AtomicObjectStorage>;
    if (!backend.replace) throw new Error('storage does not support atomic replacement');
    await backend.replace(this.path(filePath), bytes, contentType);
  }
  create(filePath: string, bytes: Uint8Array, metadata: ObjectHttpMetadata): Promise<boolean> {
    const backend = this.storage as ObjectStorage & Partial<ConditionalObjectWriter>;
    if (!backend.create) throw new Error('storage does not support conditional creation');
    return backend.create(this.path(filePath), bytes, metadata);
  }
  readDocument(filePath: string, maxBytes?: number) {
    const backend = this.storage as ObjectStorage & Partial<ConditionalDocumentStore>;
    if (!backend.readDocument) throw new Error('storage does not support conditional documents');
    return backend.readDocument(this.path(filePath), maxBytes);
  }
  compareExchange(filePath: string, expectedToken: string | null, bytes: Uint8Array) {
    const backend = this.storage as ObjectStorage & Partial<ConditionalDocumentStore>;
    if (!backend.compareExchange) throw new Error('storage does not support conditional documents');
    return backend.compareExchange(this.path(filePath), expectedToken, bytes);
  }
  delete(filePath: string) {
    return this.storage.delete(this.path(filePath));
  }
  deletePrefix(prefix: string) {
    return this.storage.deletePrefix(this.path(prefix));
  }
  async stat(filePath: string): Promise<StoredFileInfo | null> {
    const info = await this.storage.stat(this.path(filePath));
    return info ? { ...info, path: this.unprefix(info.path) } : null;
  }
  async list(prefix = ''): Promise<StoredFileInfo[]> {
    return (await this.storage.list(this.path(prefix))).map((info) => ({ ...info, path: this.unprefix(info.path) }));
  }
  listDirectories(prefix = '') {
    return this.storage.listDirectories(this.path(prefix));
  }
  async *scan(prefix = ''): AsyncIterable<StoredFileInfo> {
    const backend = this.storage as ObjectStorage & Partial<import('./capabilities.js').ObjectScanner>;
    if (!backend.scan) throw new Error('storage does not support bounded object inventory');
    for await (const info of backend.scan(this.path(prefix))) yield { ...info, path: this.unprefix(info.path) };
  }
}
