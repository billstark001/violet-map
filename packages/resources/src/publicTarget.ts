import { readLimitedBody } from '@violet-map/core/http';
import { ResourceError, type ArtifactRef } from '@violet-map/core/resources';
import type { ObjectReader } from '@violet-map/core/storage';
import { ContentAddressedStorage, createPublicObjectUrl, publicObjectKey, verifyArtifact } from '@violet-map/storage';
import type { PublicationStore } from './publication.js';
import { ByteBudget } from './budget.js';

export class PublicTarget {
  private readonly cas: ContentAddressedStorage;
  private readonly url: (key: string) => string;
  readonly metrics = { put: 0, uploadedBytes: 0, verifyGet: 0 };
  constructor(
    private readonly reader: ObjectReader,
    private readonly writer:
      | (ObjectReader &
          import('@violet-map/storage').ConditionalObjectWriter &
          import('@violet-map/storage').ObjectScanner & { delete(key: string): Promise<void> })
      | undefined,
    baseUrl: string,
    private readonly authority: PublicationStore,
    private readonly origins: readonly string[],
    private readonly work = new ByteBudget(128 * 1024 ** 2),
  ) {
    this.cas = new ContentAddressedStorage(reader, writer);
    this.url = createPublicObjectUrl(baseUrl);
  }
  async ensure(ref: ArtifactRef, bytes: Uint8Array): Promise<void> {
    const key = publicObjectKey(ref);
    const existing = await this.reader.stat(key);
    if (existing) {
      if (existing.size !== ref.bytes)
        throw new ResourceError('RESOURCE_INTEGRITY_FAILED', 'public object size conflict');
      return;
    }
    if (!this.writer) throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'public object is not published');
    await this.authority.acquire();
    if (
      await this.cas.ensure(ref, bytes, key, {
        contentType: ref.mediaType,
        cacheControl: 'public, max-age=31536000, immutable',
        digest: ref.digest,
      })
    ) {
      this.metrics.put++;
      this.metrics.uploadedBytes += bytes.byteLength;
    }
  }
  async verify(ref: ArtifactRef): Promise<void> {
    const release = this.work.reserve(ref.bytes * 2);
    try {
      // Verify the real public channel before commit; no authenticated source credentials are used.
      for (const origin of this.origins.length ? this.origins : ['*']) {
        const response = await fetch(this.url(publicObjectKey(ref)), {
          headers: { origin: origin === '*' ? 'https://violet-resource-verification.invalid' : origin },
          credentials: 'omit',
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
        });
        this.metrics.verifyGet++;
        const cors = response.headers.get('access-control-allow-origin');
        if (
          !response.ok ||
          response.headers.get('content-type')?.split(';')[0] !== ref.mediaType ||
          !response.headers.get('cache-control')?.includes('immutable') ||
          (cors !== '*' && cors !== (origin === '*' ? 'https://violet-resource-verification.invalid' : origin))
        ) {
          await response.body?.cancel();
          throw new ResourceError('RESOURCE_INTEGRITY_FAILED', 'public resource HTTP/CORS contract failed');
        }
        const bytes = await readLimitedBody(response, ref.bytes);
        if (!bytes) throw new ResourceError('RESOURCE_INTEGRITY_FAILED', 'public resource exceeds declared byte size');
        verifyArtifact(ref, bytes);
      }
    } finally {
      release();
    }
  }
  async exists(ref: ArtifactRef): Promise<boolean> {
    const info = await this.reader.stat(publicObjectKey(ref));
    if (!info) return false;
    if (info.size !== ref.bytes) throw new ResourceError('RESOURCE_INTEGRITY_FAILED', 'public object size mismatch');
    return true;
  }
  async *inventory() {
    if (!this.writer) throw new Error('public target is read-only');
    yield* this.writer.scan('objects');
  }
  async deleteObject(key: string) {
    if (!this.writer || !/^objects\/[a-f0-9]{2}\/[a-f0-9]{64}$/.test(key))
      throw new Error('invalid public object GC key');
    await this.authority.assertWriter();
    await this.writer.delete(key);
  }
}
