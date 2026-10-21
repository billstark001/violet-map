import { LruCache } from '@violet-map/core/cache';
import { readLimitedBody } from '@violet-map/core/http';
import { parseResourceRef, ResourceError, type ResourceRef } from '@violet-map/core/resources';
import { resolveApiResourceUrl } from '../runtime';

/** Shared anonymous, integrity-checked transport. Every failure stays on the selected URL. */
export class ResourceDownloader {
  private readonly cache: LruCache<string, Uint8Array<ArrayBuffer>>;
  private readonly pending = new Map<
    string,
    { promise: Promise<Uint8Array<ArrayBuffer>>; controller: AbortController; users: number }
  >();
  private activeBytes = 0;
  constructor(
    memoryBytes = 32 * 1024 ** 2,
    private readonly inFlightBytes = 64 * 1024 ** 2,
    private readonly maxRequests = 8,
  ) {
    if (
      !Number.isSafeInteger(memoryBytes) ||
      memoryBytes < 0 ||
      !Number.isSafeInteger(inFlightBytes) ||
      inFlightBytes < 1 ||
      !Number.isSafeInteger(maxRequests) ||
      maxRequests < 1
    )
      throw new RangeError('invalid resource download budget');
    this.cache = new LruCache({
      maxEntries: 4096,
      maxWeight: memoryBytes,
      weightOf: (bytes) => Math.max(1, bytes.byteLength),
    });
  }
  async download(reference: ResourceRef, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
    const ref = parseResourceRef(reference);
    signal?.throwIfAborted();
    const key = `${ref.artifact.digest}:${ref.artifact.bytes}:${ref.artifact.mediaType}:${ref.artifact.format}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    let pending = this.pending.get(key);
    if (!pending) {
      if (
        ref.artifact.bytes > this.inFlightBytes ||
        this.activeBytes > this.inFlightBytes - ref.artifact.bytes ||
        this.pending.size >= this.maxRequests
      )
        throw new ResourceError('RESOURCE_BUSY', 'resource download budget exhausted', true);
      this.activeBytes += ref.artifact.bytes;
      const controller = new AbortController();
      const url = ref.url.startsWith('/') ? resolveApiResourceUrl(ref.url) : ref.url;
      const promise = (async () => {
        const downloadSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
        const response = await fetch(url, { signal: downloadSignal, credentials: 'omit', redirect: 'error' });
        if (!response.ok) {
          const status = response.status;
          await response.body?.cancel();
          throw new ResourceError(
            status === 409 ? 'RESOURCE_VIEW_EXPIRED' : 'RESOURCE_BACKEND_UNAVAILABLE',
            `${ref.kind}: HTTP ${status}`,
            status >= 500 || status === 409 || status === 429,
          );
        }
        if (response.headers.get('content-type')?.split(';')[0] !== ref.artifact.mediaType) {
          await response.body?.cancel();
          throw new ResourceError('RESOURCE_INTEGRITY_FAILED', `${ref.kind}: incorrect content type`);
        }
        const bytes = await readLimitedBody(response, ref.artifact.bytes);
        if (!bytes || bytes.byteLength !== ref.artifact.bytes)
          throw new ResourceError('RESOURCE_INTEGRITY_FAILED', `${ref.kind}: incorrect resource size`);
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
        if (digest !== ref.artifact.digest)
          throw new ResourceError('RESOURCE_INTEGRITY_FAILED', `${ref.kind}: incorrect resource digest`);
        downloadSignal.throwIfAborted();
        this.cache.set(key, bytes);
        return bytes;
      })().finally(() => {
        this.activeBytes -= ref.artifact.bytes;
        this.pending.delete(key);
      });
      pending = { promise, controller, users: 0 };
      this.pending.set(key, pending);
    }
    if (pending.users >= 256) throw new ResourceError('RESOURCE_BUSY', 'too many resource download waiters', true);
    const shared = pending;
    shared.users++;
    let cancel: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(signal?.reason ?? new DOMException('resource download aborted', 'AbortError'));
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    });
    try {
      return await Promise.race([shared.promise, aborted]);
    } finally {
      if (cancel) signal?.removeEventListener('abort', cancel);
      shared.users--;
      if (shared.users === 0 && this.pending.get(key) === shared) shared.controller.abort();
    }
  }
  clear() {
    this.cache.clear();
    for (const pending of this.pending.values()) pending.controller.abort();
  }
}

export const resourceDownloader = new ResourceDownloader();
