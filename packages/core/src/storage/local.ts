import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { cleanStoragePath } from './paths.js';
import type { StoredFileInfo, WorldStorage } from './types.js';

/** Node filesystem implementation. `root` is never exposed through storage paths. */
export class LocalWorldStorage implements WorldStorage {
  readonly kind = 'local' as const;
  private readonly root: string;

  constructor(root: string) { this.root = path.resolve(root); }

  private abs(filePath: string): string {
    const clean = cleanStoragePath(filePath);
    const abs = path.resolve(this.root, clean);
    if (abs !== this.root && !abs.startsWith(`${this.root}${path.sep}`)) throw new Error('invalid storage path');
    return abs;
  }

  async read(filePath: string): Promise<Uint8Array | null> {
    try { return new Uint8Array(await fs.readFile(this.abs(filePath))); } catch { return null; }
  }

  async readRange(filePath: string, start: number, length: number): Promise<Uint8Array | null> {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(this.abs(filePath), 'r');
      const buffer = Buffer.alloc(Math.max(0, length));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, Math.max(0, start));
      return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead).slice();
    } catch { return null; } finally { await handle?.close().catch(() => {}); }
  }

  async write(filePath: string, bytes: Uint8Array): Promise<void> {
    const file = this.abs(filePath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }

  async delete(filePath: string): Promise<void> { await fs.rm(this.abs(filePath), { force: true }).catch(() => {}); }

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
    } catch { return null; }
  }

  async list(prefix = ''): Promise<StoredFileInfo[]> {
    const base = this.abs(cleanStoragePath(prefix));
    const files: StoredFileInfo[] = [];
    const walk = async (directory: string) => {
      let entries: Dirent[];
      try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile()) {
          const stat = await fs.stat(file);
          files.push({ path: path.relative(this.root, file).split(path.sep).join('/'), size: stat.size, modifiedAt: stat.mtimeMs });
        }
      }
    };
    await walk(base);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  async listDirectories(prefix = ''): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.abs(cleanStoragePath(prefix)), { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch { return []; }
  }
}
