import { readLimitedBody } from '@violet-map/core/http';
import { ResourceError } from '@violet-map/core/resources';
import type { ObjectReader, StoredFileInfo } from '@violet-map/core/storage';
import type { ConditionalObjectWriter, ObjectHttpMetadata, ObjectScanner } from './capabilities.js';
import { createPublicObjectUrl } from './publicUrl.js';
import { StaticHttpPublisher } from './staticHttpPublisher.js';

/** Public bodies and authenticated maintenance are separate explicit channels. */
export class HttpCasStorage implements ObjectReader, ConditionalObjectWriter, ObjectScanner {
  readonly kind = 'http' as const;
  private readonly url: (key: string) => string;
  private readonly upload?: StaticHttpPublisher;
  constructor(
    publicBaseUrl: string,
    private readonly publisher?: { url: string; token: string },
  ) {
    this.url = createPublicObjectUrl(publicBaseUrl);
    if (publisher) this.upload = new StaticHttpPublisher(publisher.url, publicBaseUrl, publisher.token);
  }
  private async get(key: string, method = 'GET', headers: Record<string, string> = {}) {
    const response = await fetch(this.url(key), {
      method,
      headers,
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ResourceError('RESOURCE_BACKEND_UNAVAILABLE', 'public HTTP object request failed', true);
    }
    return response;
  }
  async stat(key: string): Promise<StoredFileInfo | null> {
    if (this.upload && /^objects\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(key)) {
      const representation = key.split('/')[2];
      // Probe absence privately; a public pre-upload HEAD could poison a CDN
      // with a negative cache entry before the atomic PUT completes.
      if ((await this.upload.missingObjects([representation])).has(representation)) return null;
    }
    const response = await this.get(key, 'HEAD');
    if (!response) return null;
    const size = Number(response.headers.get('content-length'));
    if (!response.headers.has('content-length') || !Number.isSafeInteger(size) || size < 0)
      throw new ResourceError('RESOURCE_INTEGRITY_FAILED', 'HTTP object length is required');
    const modifiedAt = Date.parse(response.headers.get('last-modified') ?? '');
    return {
      path: key,
      size,
      ...(Number.isFinite(modifiedAt) ? { modifiedAt } : {}),
      ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}),
    };
  }
  async read(key: string) {
    const info = await this.stat(key);
    if (!info) return null;
    return this.readRange(key, 0, info.size);
  }
  async readRange(key: string, start: number, length: number) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0)
      throw new RangeError('invalid HTTP object range');
    if (!length) return new Uint8Array();
    const response = await this.get(key, 'GET', { range: `bytes=${start}-${start + length - 1}` });
    if (!response) return null;
    if (start > 0 && response.status !== 206) {
      await response.body?.cancel();
      throw new ResourceError('RESOURCE_BACKEND_UNAVAILABLE', 'HTTP CAS requires byte range support');
    }
    const bytes = await readLimitedBody(response, length);
    if (!bytes) throw new ResourceError('RESOURCE_INTEGRITY_FAILED', 'HTTP object exceeds requested bytes');
    return bytes;
  }
  async create(key: string, bytes: Uint8Array, metadata: ObjectHttpMetadata) {
    if (!this.upload || !metadata.digest) throw new Error('HTTP CAS upload capability is not configured');
    const { publicObjectKey } = await import('./contentAddressed.js');
    const ref = { digest: metadata.digest, bytes: bytes.length, mediaType: metadata.contentType, format: 'opaque' };
    if (publicObjectKey(ref) !== key) throw new TypeError('HTTP CAS accepts canonical public objects only');
    return this.upload.ensure(ref, bytes);
  }
  private async maintenance(key: string, method = 'GET', query?: Record<string, string>) {
    if (!this.publisher) throw new Error('HTTP CAS maintenance requires publish role');
    const endpoint = createPublicObjectUrl(this.publisher.url);
    const url = new URL(endpoint(key));
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    const response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${this.publisher.token}` },
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ResourceError('RESOURCE_BACKEND_UNAVAILABLE', 'HTTP CAS maintenance failed', true);
    }
    return response;
  }
  async *scan(prefix = ''): AsyncIterable<StoredFileInfo> {
    let cursor = '';
    const seen = new Set<string>();
    for (let page = 0; ; page++) {
      if (page >= 100000) throw new ResourceError('RESOURCE_BUSY', 'HTTP CAS inventory page bound exceeded');
      const response = await this.maintenance('v1/inventory', 'GET', { cursor });
      const raw = await readLimitedBody(response, 1024 ** 2);
      if (!raw) throw new ResourceError('RESOURCE_BUSY', 'HTTP CAS inventory page exceeds budget');
      const value = JSON.parse(new TextDecoder().decode(raw));
      if (!Array.isArray(value.objects) || value.objects.length > 1000 || typeof value.nextCursor !== 'string')
        throw new TypeError('invalid HTTP CAS inventory page');
      for (const item of value.objects) {
        if (
          !/^objects\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(item.path) ||
          !Number.isSafeInteger(item.size) ||
          item.size < 0 ||
          !Number.isFinite(item.modifiedAt)
        )
          throw new TypeError('invalid HTTP CAS inventory item');
        if (!prefix || item.path.startsWith(prefix + '/')) yield item;
      }
      if (!value.nextCursor) return;
      if (value.nextCursor === cursor || seen.has(value.nextCursor))
        throw new Error('HTTP CAS inventory cursor did not advance');
      if (seen.size >= 1024) seen.clear();
      seen.add(cursor);
      cursor = value.nextCursor;
    }
  }
  async list(prefix = '') {
    const items: StoredFileInfo[] = [];
    for await (const item of this.scan(prefix)) {
      if (items.length >= 10000) throw new ResourceError('RESOURCE_BUSY', 'HTTP CAS list exceeds metadata budget');
      items.push(item);
    }
    return items;
  }
  async listDirectories(): Promise<string[]> {
    throw new Error('HTTP CAS has no source directory capability');
  }
  async delete(key: string) {
    if (!/^objects\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(key)) throw new TypeError('invalid HTTP CAS delete key');
    const response = await this.maintenance(`v1/objects/${key.split('/')[2]}`, 'DELETE');
    await response.body?.cancel();
  }
}
