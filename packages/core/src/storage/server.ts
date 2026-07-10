import { cleanStoragePath } from './paths.js';
import type { ServerStorageOptions, StoredFileInfo, WorldStorage } from './types.js';

/** WorldStorage adapter for a remote Violet Map server's protected storage API. */
export class ServerWorldStorage implements WorldStorage {
  readonly kind = 'server' as const;
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(options: ServerStorageOptions) {
    if (!options.url || !options.token) throw new Error('server URL and credential are required');
    this.baseUrl = options.url.replace(/\/+$/, '');
    this.token = options.token;
  }

  private url(path: string, query?: Record<string, string>): string {
    const url = new URL(`/api/admin/storage/${path.replace(/^\/+/, '')}`, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    return url.toString();
  }
  private headers(extra: HeadersInit = {}): HeadersInit { return { ...extra, authorization: `Bearer ${this.token}` }; }
  private async required(response: Response): Promise<Response> {
    if (!response.ok) throw new Error(`remote storage request failed: ${response.status}`);
    return response;
  }

  async read(filePath: string): Promise<Uint8Array | null> {
    const response = await fetch(this.url(`files/${encodeURIComponent(cleanStoragePath(filePath))}`), { headers: this.headers() });
    if (response.status === 404) return null;
    return new Uint8Array(await (await this.required(response)).arrayBuffer());
  }
  async readRange(filePath: string, start: number, length: number): Promise<Uint8Array | null> {
    const response = await fetch(this.url(`files/${encodeURIComponent(cleanStoragePath(filePath))}`), {
      headers: this.headers({ range: `bytes=${Math.max(0, start)}-${Math.max(0, start + Math.max(0, length) - 1)}` }),
    });
    if (response.status === 404) return null;
    return new Uint8Array(await (await this.required(response)).arrayBuffer());
  }
  async write(filePath: string, bytes: Uint8Array, contentType = 'application/octet-stream'): Promise<void> {
    await this.required(await fetch(this.url(`files/${encodeURIComponent(cleanStoragePath(filePath))}`), {
      method: 'PUT', headers: this.headers({ 'content-type': contentType }), body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    }));
  }
  async delete(filePath: string): Promise<void> {
    await this.required(await fetch(this.url(`files/${encodeURIComponent(cleanStoragePath(filePath))}`), { method: 'DELETE', headers: this.headers() }));
  }
  async deletePrefix(prefix: string): Promise<number> { const files = await this.list(prefix); await Promise.all(files.map((file) => this.delete(file.path))); return files.length; }
  async stat(filePath: string): Promise<StoredFileInfo | null> {
    const response = await fetch(this.url(`stat/${encodeURIComponent(cleanStoragePath(filePath))}`), { headers: this.headers() });
    if (response.status === 404) return null;
    return (await (await this.required(response)).json()) as StoredFileInfo;
  }
  async list(prefix = ''): Promise<StoredFileInfo[]> {
    const response = await this.required(await fetch(this.url('list', { prefix: cleanStoragePath(prefix) }), { headers: this.headers() }));
    return response.json() as Promise<StoredFileInfo[]>;
  }
  async listDirectories(prefix = ''): Promise<string[]> {
    const response = await this.required(await fetch(this.url('directories', { prefix: cleanStoragePath(prefix) }), { headers: this.headers() }));
    return response.json() as Promise<string[]>;
  }
}
