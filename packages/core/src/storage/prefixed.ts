import { cleanStoragePath, joinStoragePath } from './paths.js';
import type { StoredFileInfo, WorldStorage } from './types.js';

/** Presents a directory inside another storage as its own storage root. */
export class PrefixedWorldStorage implements WorldStorage {
  readonly kind: WorldStorage['kind'];
  private readonly prefix: string;
  constructor(private readonly storage: WorldStorage, prefix = '') { this.kind = storage.kind; this.prefix = cleanStoragePath(prefix); }
  private path(filePath: string): string { return joinStoragePath(this.prefix, cleanStoragePath(filePath)); }
  private unprefix(filePath: string): string { return this.prefix && filePath.startsWith(`${this.prefix}/`) ? filePath.slice(this.prefix.length + 1) : filePath; }
  read(filePath: string) { return this.storage.read(this.path(filePath)); }
  readRange(filePath: string, start: number, length: number) { return this.storage.readRange(this.path(filePath), start, length); }
  write(filePath: string, bytes: Uint8Array, contentType?: string) { return this.storage.write(this.path(filePath), bytes, contentType); }
  delete(filePath: string) { return this.storage.delete(this.path(filePath)); }
  deletePrefix(prefix: string) { return this.storage.deletePrefix(this.path(prefix)); }
  async stat(filePath: string): Promise<StoredFileInfo | null> { const info = await this.storage.stat(this.path(filePath)); return info ? { ...info, path: this.unprefix(info.path) } : null; }
  async list(prefix = ''): Promise<StoredFileInfo[]> { return (await this.storage.list(this.path(prefix))).map((info) => ({ ...info, path: this.unprefix(info.path) })); }
  listDirectories(prefix = '') { return this.storage.listDirectories(this.path(prefix)); }
}
