import type { ObjectStorage, StoredFileInfo } from '@violet-map/core/storage';
import type { ObjectCapabilities } from './capabilities.js';
import { cleanStoragePath, joinStoragePath } from './paths.js';

/** Presents a directory inside another storage as its own storage root. */
export class ScopedStorage implements ObjectStorage {
  readonly scan?: ObjectCapabilities['scan'];
  readonly create?: ObjectCapabilities['create'];
  readonly readDocument?: ObjectCapabilities['readDocument'];
  readonly compareExchange?: ObjectCapabilities['compareExchange'];
  readonly replace?: ObjectCapabilities['replace'];
  readonly kind: ObjectStorage['kind'];
  private readonly prefix: string;
  constructor(
    private readonly storage: ObjectStorage,
    prefix = '',
  ) {
    const backend = storage as ObjectStorage & Partial<ObjectCapabilities>;
    if (backend.scan)
      this.scan = async function* (this: ScopedStorage, prefix = '') {
        for await (const info of backend.scan!(this.path(prefix))) yield { ...info, path: this.unprefix(info.path) };
      }.bind(this);
    if (backend.create)
      this.create = (filePath, bytes, metadata) => {
        return backend.create!(this.path(filePath), bytes, metadata);
      };
    if (backend.readDocument)
      this.readDocument = (filePath, maxBytes) => {
        return backend.readDocument!(this.path(filePath), maxBytes);
      };
    if (backend.compareExchange)
      this.compareExchange = (filePath, expectedToken, bytes) => {
        return backend.compareExchange!(this.path(filePath), expectedToken, bytes);
      };
    if (backend.replace)
      this.replace = async (filePath, bytes, contentType) => {
        await backend.replace!(this.path(filePath), bytes, contentType);
      };

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
}
