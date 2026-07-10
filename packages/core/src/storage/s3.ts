import {
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { cleanStoragePath } from './paths.js';
import type { S3StorageOptions, StoredFileInfo, WorldStorage } from './types.js';

async function bodyToBytes(body: unknown): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  if (body instanceof Uint8Array) return body;
  if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === 'function') {
    return (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

/** S3 and S3-compatible implementation. */
export class S3WorldStorage implements WorldStorage {
  readonly kind = 's3' as const;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(options: S3StorageOptions) {
    if (!options.bucket) throw new Error('S3 bucket is required');
    this.bucket = options.bucket;
    this.prefix = cleanStoragePath(options.prefix ?? '');
    this.client = new S3Client({
      endpoint: options.endpoint, region: options.region ?? 'auto', forcePathStyle: options.forcePathStyle ?? true,
      credentials: options.accessKeyId && options.secretAccessKey ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey } : undefined,
    });
  }

  private key(filePath: string): string { const clean = cleanStoragePath(filePath); return this.prefix ? `${this.prefix}/${clean}` : clean; }
  private relative(key: string): string { return !this.prefix ? key : key.startsWith(`${this.prefix}/`) ? key.slice(this.prefix.length + 1) : key; }

  async read(filePath: string): Promise<Uint8Array | null> {
    try { return bodyToBytes((await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(filePath) }))).Body); } catch { return null; }
  }

  async readRange(filePath: string, start: number, length: number): Promise<Uint8Array | null> {
    try {
      const begin = Math.max(0, start), end = Math.max(begin, begin + Math.max(0, length) - 1);
      return bodyToBytes((await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(filePath), Range: `bytes=${begin}-${end}` }))).Body);
    } catch { return null; }
  }

  async write(filePath: string, bytes: Uint8Array, contentType = 'application/octet-stream'): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key(filePath), Body: bytes, ContentType: contentType }));
  }
  async delete(filePath: string): Promise<void> { await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(filePath) })); }
  async deletePrefix(prefix: string): Promise<number> { const files = await this.list(prefix); await Promise.all(files.map((file) => this.delete(file.path))); return files.length; }

  async stat(filePath: string): Promise<StoredFileInfo | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(filePath) }));
      return { path: cleanStoragePath(filePath), size: result.ContentLength ?? 0, modifiedAt: result.LastModified?.getTime(), etag: result.ETag?.replace(/^"|"$/g, '') };
    } catch { return null; }
  }

  async list(prefix = ''): Promise<StoredFileInfo[]> {
    const files: StoredFileInfo[] = [];
    const cleanPrefix = prefix ? `${cleanStoragePath(prefix).replace(/\/?$/, '')}/` : '';
    const Prefix = this.prefix ? `${this.prefix}/${cleanPrefix}` : cleanPrefix;
    let ContinuationToken: string | undefined;
    do {
      const result = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix, ContinuationToken }));
      for (const object of result.Contents ?? []) if (object.Key && !object.Key.endsWith('/')) files.push({
        path: this.relative(object.Key), size: object.Size ?? 0, modifiedAt: object.LastModified?.getTime(), etag: object.ETag?.replace(/^"|"$/g, ''),
      });
      ContinuationToken = result.NextContinuationToken;
    } while (ContinuationToken);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  async listDirectories(prefix = ''): Promise<string[]> {
    const cleanPrefix = prefix ? `${cleanStoragePath(prefix).replace(/\/?$/, '')}/` : '';
    const Prefix = this.prefix ? `${this.prefix}/${cleanPrefix}` : cleanPrefix;
    const dirs = new Set<string>();
    let ContinuationToken: string | undefined;
    do {
      const result = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix, Delimiter: '/', ContinuationToken }));
      for (const item of result.CommonPrefixes ?? []) if (item.Prefix) {
        const dir = this.relative(item.Prefix).slice(cleanPrefix.length).replace(/\/$/, '');
        if (dir) dirs.add(dir);
      }
      ContinuationToken = result.NextContinuationToken;
    } while (ContinuationToken);
    return [...dirs].sort();
  }
}
