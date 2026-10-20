import { ResourceError } from '@violet-map/core/resources';
import { mapWithConcurrency } from '@violet-map/core/async';
import type { ObjectStorage, StoredFileInfo } from '@violet-map/core/storage';
import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ObjectHttpMetadata } from './capabilities.js';
import { cleanStoragePath } from './paths.js';
import { validateReadRange } from './range.js';

function isMissingPath(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Adopt an exclusive filesystem allocation; trim pooled or short-read views so
 * one retained object never pins unrelated pool bytes or an unused read tail. */
function ownedFileBytes(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? new Uint8Array(bytes.buffer)
    : new Uint8Array(bytes);
}

/** Node filesystem implementation. `root` is never exposed through storage paths. */
export class LocalStorage implements ObjectStorage {
  readonly kind = 'local' as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }
  /** Explicit opt-in write preflight; read-only readers never invoke this method. */
  async prepareDirectory(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const probe = path.join(this.root, `.violet-tmp-${randomUUID()}`);
    const handle = await fs.open(probe, 'wx');
    try {
      await handle.close();
    } finally {
      await fs.rm(probe, { force: true });
    }
  }

  private abs(filePath: string): string {
    const clean = cleanStoragePath(filePath);
    const abs = path.resolve(this.root, clean);
    const relative = path.relative(this.root, abs);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error('invalid storage path');
    return abs;
  }

  async read(filePath: string): Promise<Uint8Array | null> {
    try {
      return ownedFileBytes(await fs.readFile(this.abs(filePath)));
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      return null;
    }
  }

  async readRange(filePath: string, start: number, length: number): Promise<Uint8Array | null> {
    validateReadRange(start, length);
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(this.abs(filePath), 'r');
      if (length === 0) return new Uint8Array();
      const { size } = await handle.stat();
      const available = Math.min(length, Math.max(0, size - start));
      if (available === 0) return new Uint8Array();
      const buffer = Buffer.allocUnsafe(available);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, start);
      return ownedFileBytes(buffer.subarray(0, bytesRead));
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async write(filePath: string, bytes: Uint8Array): Promise<void> {
    const file = this.abs(filePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }

  async replace(filePath: string, bytes: Uint8Array): Promise<void> {
    const file = this.abs(filePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(path.dirname(file), `.violet-tmp-${randomUUID()}`);
    try {
      const handle = await fs.open(temporary, 'wx');
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, file);
      const parent = await fs.open(path.dirname(file), 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  /** Link a completed file exclusively, so a reader never sees a partial create. */
  async create(filePath: string, bytes: Uint8Array, _metadata: ObjectHttpMetadata): Promise<boolean> {
    const file = this.abs(filePath);
    const directory = path.dirname(file);
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.violet-tmp-${randomUUID()}`);
    const handle = await fs.open(temporary, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      if (_metadata.cacheControl) {
        const metadataFile = this.abs(
          `.violet-http/${createHash('sha256').update(cleanStoragePath(filePath)).digest('hex')}.json`,
        );
        await fs.mkdir(path.dirname(metadataFile), { recursive: true });
        const metadataTemporary = path.join(path.dirname(metadataFile), `.violet-tmp-${randomUUID()}`);
        try {
          const metadataHandle = await fs.open(metadataTemporary, 'wx');
          try {
            await metadataHandle.writeFile(JSON.stringify(_metadata));
            await metadataHandle.sync();
          } finally {
            await metadataHandle.close();
          }
          try {
            await fs.link(metadataTemporary, metadataFile);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const saved = JSON.parse(await fs.readFile(metadataFile, 'utf8'));
            if (
              JSON.stringify([saved.contentType, saved.cacheControl, saved.digest]) !==
              JSON.stringify([_metadata.contentType, _metadata.cacheControl, _metadata.digest])
            )
              throw new Error('immutable object HTTP metadata conflict');
          }
          const metadataParent = await fs.open(path.dirname(metadataFile), 'r');
          try {
            await metadataParent.sync();
          } finally {
            await metadataParent.close();
          }
        } finally {
          await fs.rm(metadataTemporary, { force: true });
        }
      }
      try {
        await fs.link(temporary, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
      const parent = await fs.open(directory, 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      return true;
    } finally {
      await handle.close();
      await fs.rm(temporary, { force: true });
    }
  }

  async readDocument(filePath: string, maxBytes?: number): Promise<{ bytes: Uint8Array; token: string } | null> {
    const limit = maxBytes ?? 8 * 1024 ** 2;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('invalid conditional document limit');
    const bytes = await this.readRange(filePath, 0, limit + 1);
    if (bytes && bytes.length > limit)
      throw new ResourceError('RESOURCE_BUSY', 'conditional document exceeds read budget');
    return bytes ? { bytes, token: createHash('sha256').update(bytes).digest('hex') } : null;
  }

  /** Local single-object compare/exchange. A leftover lock requires explicit operator recovery. */
  async compareExchange(filePath: string, expectedToken: string | null, bytes: Uint8Array): Promise<boolean> {
    const file = this.abs(filePath);
    const directory = path.dirname(file);
    await fs.mkdir(directory, { recursive: true });
    const lockPath = file + '.violet-lock';
    const lock = await fs.open(lockPath, 'wx');
    const temporary = path.join(directory, `.violet-tmp-${randomUUID()}`);
    try {
      const current = await this.readDocument(filePath);
      if ((current?.token ?? null) !== expectedToken) return false;
      const handle = await fs.open(temporary, 'wx');
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, file);
      const parent = await fs.open(directory, 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      return true;
    } finally {
      await fs.rm(temporary, { force: true });
      await lock.close();
      await fs.rm(lockPath);
    }
  }

  async delete(filePath: string): Promise<void> {
    await fs.rm(this.abs(filePath), { force: true });
    await fs.rm(
      this.abs(`.violet-http/${createHash('sha256').update(cleanStoragePath(filePath)).digest('hex')}.json`),
      { force: true },
    );
  }
  async httpMetadata(filePath: string): Promise<ObjectHttpMetadata | null> {
    const bytes = await this.read(
      `.violet-http/${createHash('sha256').update(cleanStoragePath(filePath)).digest('hex')}.json`,
    );
    return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as ObjectHttpMetadata) : null;
  }

  async deletePrefix(prefix: string): Promise<number> {
    const clean = cleanStoragePath(prefix);
    const files = await this.list(clean);
    try {
      if ((await fs.lstat(this.abs(clean))).isDirectory())
        await fs.rm(this.abs(clean), { recursive: true, force: true });
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
    return files.length;
  }

  async stat(filePath: string): Promise<StoredFileInfo | null> {
    try {
      const stat = await fs.stat(this.abs(filePath));
      return stat.isFile() ? { path: cleanStoragePath(filePath), size: stat.size, modifiedAt: stat.mtimeMs } : null;
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      return null;
    }
  }

  async list(prefix = ''): Promise<StoredFileInfo[]> {
    const base = this.abs(cleanStoragePath(prefix));
    const paths: string[] = [];
    const walk = async (directory: string) => {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (!isMissingPath(error)) throw error;
        return;
      }
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory() && entry.name !== '.violet-http') await walk(file);
        else if (entry.isFile() && !entry.name.startsWith('.violet-tmp-')) paths.push(file);
      }
    };
    await walk(base);
    const files = await mapWithConcurrency(paths, 32, async (file): Promise<StoredFileInfo | null> => {
      try {
        const stat = await fs.stat(file);
        return {
          path: path.relative(this.root, file).split(path.sep).join('/'),
          size: stat.size,
          modifiedAt: stat.mtimeMs,
        };
      } catch (error) {
        if (isMissingPath(error)) return null;
        throw error;
      }
    });
    return files.filter((file): file is StoredFileInfo => file !== null).sort((a, b) => a.path.localeCompare(b.path));
  }

  async *scan(prefix = ''): AsyncIterable<StoredFileInfo> {
    const root = this.abs(prefix);
    const walk = async function* (directory: string): AsyncIterable<string> {
      let entries;
      try {
        entries = await fs.opendir(directory);
      } catch (error) {
        if (isMissingPath(error)) return;
        throw error;
      }
      for await (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory() && entry.name !== '.violet-http') yield* walk(file);
        else if (entry.isFile() && !entry.name.startsWith('.violet-tmp-')) yield file;
      }
    };
    for await (const file of walk(root)) {
      const info = await this.stat(path.relative(this.root, file).split(path.sep).join('/'));
      if (info) yield info;
    }
  }

  async listDirectories(prefix = ''): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.abs(cleanStoragePath(prefix)), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && entry.name !== '.violet-http')
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      return [];
    }
  }
}
