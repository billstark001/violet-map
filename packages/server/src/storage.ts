import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

export interface StoredFileInfo {
  path: string;
  size: number;
  modifiedAt?: number;
  etag?: string;
}

export interface WorldStorage {
  readonly kind: 'osfs' | 's3';
  read(filePath: string): Promise<Uint8Array | null>;
  write(filePath: string, bytes: Uint8Array, contentType?: string): Promise<void>;
  delete(filePath: string): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
  stat(filePath: string): Promise<StoredFileInfo | null>;
  list(prefix?: string): Promise<StoredFileInfo[]>;
  listDirectories(prefix?: string): Promise<string[]>;
}

export function cleanStoragePath(input: string): string {
  const raw = input.replace(/\\/g, '/').replace(/^\/+/, '');
  const normalized = path.posix.normalize(raw);
  if (!normalized || normalized === '.') return '';
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new Error('invalid storage path');
  }
  return normalized;
}

class OsFsStorage implements WorldStorage {
  readonly kind = 'osfs' as const;
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
    } catch {
      return null;
    }
  }

  async write(filePath: string, bytes: Uint8Array): Promise<void> {
    const abs = this.abs(filePath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, bytes);
  }

  async delete(filePath: string): Promise<void> {
    try {
      await fs.rm(this.abs(filePath), { force: true });
    } catch {
      // Missing files are fine for idempotent admin APIs.
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    const clean = cleanStoragePath(prefix);
    const files = await this.list(clean);
    await fs.rm(this.abs(clean), { recursive: true, force: true });
    return files.length;
  }

  async stat(filePath: string): Promise<StoredFileInfo | null> {
    try {
      const s = await fs.stat(this.abs(filePath));
      if (!s.isFile()) return null;
      return { path: cleanStoragePath(filePath), size: s.size, modifiedAt: s.mtimeMs };
    } catch {
      return null;
    }
  }

  async list(prefix = ''): Promise<StoredFileInfo[]> {
    const cleanPrefix = cleanStoragePath(prefix);
    const base = this.abs(cleanPrefix);
    const out: StoredFileInfo[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(abs);
          continue;
        }
        if (!e.isFile()) continue;
        const s = await fs.stat(abs);
        const rel = path.relative(this.root, abs).split(path.sep).join('/');
        out.push({ path: rel, size: s.size, modifiedAt: s.mtimeMs });
      }
    };
    await walk(base);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async listDirectories(prefix = ''): Promise<string[]> {
    const base = this.abs(prefix);
    try {
      const entries = await fs.readdir(base, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch {
      return [];
    }
  }
}

async function bodyToBytes(body: unknown): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  if (body instanceof Uint8Array) return body;
  if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === 'function') {
    return (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
  }
  const size = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

class S3WorldStorage implements WorldStorage {
  readonly kind = 's3' as const;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor() {
    if (!config.s3.bucket) throw new Error('S3_BUCKET is required when WORLD_STORAGE=s3');
    this.bucket = config.s3.bucket;
    this.prefix = cleanStoragePath(config.s3.prefix);
    this.client = new S3Client({
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      forcePathStyle: config.s3.forcePathStyle,
      credentials: config.s3.accessKeyId && config.s3.secretAccessKey
        ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
        : undefined,
    });
  }

  private key(filePath: string): string {
    const clean = cleanStoragePath(filePath);
    return this.prefix ? `${this.prefix}/${clean}` : clean;
  }

  private rel(key: string): string {
    if (!this.prefix) return key;
    return key.startsWith(`${this.prefix}/`) ? key.slice(this.prefix.length + 1) : key;
  }

  async read(filePath: string): Promise<Uint8Array | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(filePath) }));
      return bodyToBytes(res.Body);
    } catch {
      return null;
    }
  }

  async write(filePath: string, bytes: Uint8Array, contentType = 'application/octet-stream'): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.key(filePath),
      Body: bytes,
      ContentType: contentType,
    }));
  }

  async delete(filePath: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(filePath) }));
  }

  async deletePrefix(prefix: string): Promise<number> {
    const files = await this.list(prefix);
    await Promise.all(files.map((f) => this.delete(f.path)));
    return files.length;
  }

  async stat(filePath: string): Promise<StoredFileInfo | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(filePath) }));
      return {
        path: cleanStoragePath(filePath),
        size: res.ContentLength ?? 0,
        modifiedAt: res.LastModified?.getTime(),
        etag: res.ETag?.replace(/^"|"$/g, ''),
      };
    } catch {
      return null;
    }
  }

  async list(prefix = ''): Promise<StoredFileInfo[]> {
    const out: StoredFileInfo[] = [];
    let ContinuationToken: string | undefined;
    const cleanPrefix = prefix ? cleanStoragePath(prefix).replace(/\/?$/, '/') : '';
    const Prefix = this.prefix
      ? (cleanPrefix ? `${this.prefix}/${cleanPrefix}` : `${this.prefix}/`)
      : cleanPrefix;
    do {
      const res = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix,
        ContinuationToken,
      }));
      for (const obj of res.Contents ?? []) {
        if (!obj.Key || obj.Key.endsWith('/')) continue;
        out.push({
          path: this.rel(obj.Key),
          size: obj.Size ?? 0,
          modifiedAt: obj.LastModified?.getTime(),
          etag: obj.ETag?.replace(/^"|"$/g, ''),
        });
      }
      ContinuationToken = res.NextContinuationToken;
    } while (ContinuationToken);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async listDirectories(prefix = ''): Promise<string[]> {
    const cleanPrefix = prefix ? cleanStoragePath(prefix).replace(/\/?$/, '/') : '';
    const Prefix = this.prefix
      ? (cleanPrefix ? `${this.prefix}/${cleanPrefix}` : `${this.prefix}/`)
      : cleanPrefix;
    const dirs = new Set<string>();
    let ContinuationToken: string | undefined;
    do {
      const res = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix,
        Delimiter: '/',
        ContinuationToken,
      }));
      for (const item of res.CommonPrefixes ?? []) {
        if (!item.Prefix) continue;
        const dir = this.rel(item.Prefix).slice(cleanPrefix.length).replace(/\/$/, '');
        if (dir) dirs.add(dir);
      }
      ContinuationToken = res.NextContinuationToken;
    } while (ContinuationToken);
    return [...dirs].sort();
  }
}

export const worldStorage: WorldStorage = config.worldStorage === 's3'
  ? new S3WorldStorage()
  : new OsFsStorage(config.worldsDir);
