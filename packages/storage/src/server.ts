import { normalizeApiBaseUrl, apiUrl } from '@violet-map/core/contracts';
import { cleanStoragePath } from './paths.js';
import { validateReadRange } from './range.js';
import { storageRequest } from './http.js';
import { nonSharedView } from './bytes.js';
import { forEachConcurrent } from '@violet-map/core/async';
import type { ServerStorageOptions } from '@violet-map/storage/types';
import type { StoredFileInfo, ObjectStorage } from '@violet-map/core/storage';

/** ObjectStorage adapter for a remote Violet Map server's protected storage API. */
export class ServerWorldStorage implements ObjectStorage {
  readonly kind = 'server' as const;
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(options: ServerStorageOptions) {
    if (!options.url || !options.token) throw new Error('server URL and credential are required');
    this.baseUrl = normalizeApiBaseUrl(options.url, new URL(options.url).origin);
    this.token = options.token;
  }

  private url(path: string, query?: Record<string, string>): string {
    const url = new URL(apiUrl(this.baseUrl, `api/admin/storage/${path.replace(/^\/+/, '')}`));
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    return url.toString();
  }
  private headers(extra: HeadersInit = {}): HeadersInit {
    return { ...extra, authorization: `Bearer ${this.token}` };
  }
  private async required(response: Response): Promise<Response> {
    if (!response.ok)
      throw new Error(
        `remote storage request failed: HTTP ${response.status}${response.status === 401 ? ' (sign in again or replace the credential)' : response.status === 403 ? ' (authenticated user lacks permission)' : ''}`,
      );
    return response;
  }

  async read(filePath: string): Promise<Uint8Array | null> {
    const response = await storageRequest(this.url(`files/${encodeURIComponent(cleanStoragePath(filePath))}`), {
      headers: this.headers(),
    });
    if (response.status === 404) return null;
    return new Uint8Array(await (await this.required(response)).arrayBuffer());
  }
  async readRange(filePath: string, start: number, length: number): Promise<Uint8Array | null> {
    validateReadRange(start, length);
    if (length === 0) return (await this.stat(filePath)) ? new Uint8Array() : null;
    const response = await storageRequest(this.url(`files/${encodeURIComponent(cleanStoragePath(filePath))}`), {
      headers: this.headers({ range: `bytes=${start}-${start + length - 1}` }),
    });
    if (response.status === 404) return null;
    if (response.status === 416) return (await this.stat(filePath)) ? new Uint8Array() : null;
    const bytes = new Uint8Array(await (await this.required(response)).arrayBuffer());
    // HTTP permits a server/proxy to ignore Range and return the complete 200
    // representation. Preserve ObjectReader's slice/ownership contract in that case.
    if (response.status === 200) return bytes.slice(start, start + length);
    return bytes.length > length ? bytes.slice(0, length) : bytes;
  }
  async write(filePath: string, bytes: Uint8Array, contentType = 'application/octet-stream'): Promise<void> {
    await this.required(
      await storageRequest(this.url(`files/${encodeURIComponent(cleanStoragePath(filePath))}`), {
        method: 'PUT',
        headers: this.headers({ 'content-type': contentType }),
        body: nonSharedView(bytes),
      }),
    );
  }
  async delete(filePath: string): Promise<void> {
    await this.required(
      await storageRequest(this.url(`files/${encodeURIComponent(cleanStoragePath(filePath))}`), {
        method: 'DELETE',
        headers: this.headers(),
      }),
    );
  }
  async deletePrefix(prefix: string): Promise<number> {
    const files = await this.list(prefix);
    await forEachConcurrent(files, 16, (file) => this.delete(file.path));
    return files.length;
  }
  async stat(filePath: string): Promise<StoredFileInfo | null> {
    const response = await storageRequest(this.url(`stat/${encodeURIComponent(cleanStoragePath(filePath))}`), {
      headers: this.headers(),
    });
    if (response.status === 404) return null;
    return (await (await this.required(response)).json()) as StoredFileInfo;
  }
  async list(prefix = ''): Promise<StoredFileInfo[]> {
    const response = await this.required(
      await storageRequest(this.url('list', { prefix: cleanStoragePath(prefix) }), { headers: this.headers() }),
    );
    return response.json() as Promise<StoredFileInfo[]>;
  }
  async listDirectories(prefix = ''): Promise<string[]> {
    const response = await this.required(
      await storageRequest(this.url('directories', { prefix: cleanStoragePath(prefix) }), { headers: this.headers() }),
    );
    return response.json() as Promise<string[]>;
  }
}
