import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { mapWithConcurrency } from '../async.js';
import { cleanStoragePath } from './paths.js';
import { validateReadRange } from './range.js';
import type { StoredFileInfo, WorldStorage } from './types.js';

function isMissingPath(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Node filesystem implementation. `root` is never exposed through storage paths. */
export class LocalWorldStorage implements WorldStorage {
  readonly kind = 'local' as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private abs(filePath: string): string {
    const clean = cleanStoragePath(filePath);
    const abs = path.resolve(this.root, clean);
    if (abs !== this.root && !abs.startsWith(`${this.root}${path.sep}`)) throw new Error('invalid storage path');
    return abs;
  }

  async read(filePath: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await fs.readFile(this.abs(filePath)));
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
      return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead).slice();
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

  async delete(filePath: string): Promise<void> {
    await fs.rm(this.abs(filePath), { force: true });
  }

  async deletePrefix(prefix: string): Promise<number> {
    const clean = cleanStoragePath(prefix);
    const files = await this.list(clean);
    await fs.rm(this.abs(clean), { recursive: true, force: true });
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
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile()) paths.push(file);
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

  async listDirectories(prefix = ''): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.abs(cleanStoragePath(prefix)), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      return [];
    }
  }
}
