import { LruCache } from '@violet-map/core/cache';
import { readLimitedBody } from '@violet-map/core/http';
import { parseResourceRef, ResourceError, type ResourceRef } from '@violet-map/core/resources';
import { resolveApiResourceUrl } from '../runtime';

interface DownloadJob {
  readonly key: string;
  readonly bytes: number;
  readonly promise: Promise<Uint8Array<ArrayBuffer>>;
  readonly controller: AbortController;
  users: number;
}

/** Shared anonymous, integrity-checked transport. Every failure stays on the selected URL. */
export class ResourceDownloader {
  private readonly cache: LruCache<string, Uint8Array<ArrayBuffer>>;
  private readonly pending = new Set<DownloadJob>();
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
    let pending: DownloadJob | undefined;
    let activeBytes = 0;
    for (const job of this.pending) {
      activeBytes += job.bytes;
      if (job.key === key && !job.controller.signal.aborted) pending = job;
    }
    if (!pending) {
      if (
        ref.artifact.bytes > this.inFlightBytes ||
        activeBytes > this.inFlightBytes - ref.artifact.bytes ||
        this.pending.size >= this.maxRequests
      )
        throw new ResourceError('RESOURCE_BUSY', 'resource download budget exhausted', true);
      const controller = new AbortController();
      const url = ref.url.startsWith('/') ? resolveApiResourceUrl(ref.url) : ref.url;
      const job: DownloadJob = {
        key,
        bytes: ref.artifact.bytes,
        controller,
        users: 0,
        promise: (async () => {
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
          this.pending.delete(job);
        }),
      };
      pending = job;
      this.pending.add(job);
    }
    if (pending.users >= 256) throw new ResourceError('RESOURCE_BUSY', 'too many resource download waiters', true);
    const shared = pending;
    shared.users++;
    let cancel: (() => void) | undefined;
    const aborted = signal
      ? new Promise<never>((_resolve, reject) => {
          cancel = () => reject(signal.reason);
          signal.addEventListener('abort', cancel, { once: true });
          if (signal.aborted) cancel();
        })
      : null;
    try {
      return await (aborted ? Promise.race([shared.promise, aborted]) : shared.promise);
    } finally {
      if (cancel) signal?.removeEventListener('abort', cancel);
      shared.users--;
      if (shared.users === 0 && this.pending.has(shared)) shared.controller.abort();
    }
  }
  clear() {
    this.cache.clear();
    for (const job of this.pending) job.controller.abort();
  }
}

export const resourceDownloader = new ResourceDownloader();
