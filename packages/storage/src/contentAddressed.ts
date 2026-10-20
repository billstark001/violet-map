import type { ArtifactRef } from '@violet-map/core/resources';
import { canonicalJson, parseArtifactRef, ResourceError } from '@violet-map/core/resources';
import type { ObjectReader } from '@violet-map/core/storage';
import { createHash } from 'node:crypto';
import type { ConditionalObjectWriter, ObjectHttpMetadata } from './capabilities.js';

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function artifactRef(bytes: Uint8Array, mediaType: string, format: string): ArtifactRef {
  return parseArtifactRef({ digest: sha256(bytes), bytes: bytes.byteLength, mediaType, format });
}

export function contentObjectKey(digest: string): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new TypeError('invalid content digest');
  return `sha256/${digest.slice(0, 2)}/${digest}`;
}

export function representationKey(ref: ArtifactRef): string {
  parseArtifactRef(ref);
  return sha256(canonicalJson({ schema: 1, digest: ref.digest, mediaType: ref.mediaType, encoding: 'identity' }));
}

export function publicObjectKey(ref: ArtifactRef): string {
  const key = representationKey(ref);
  return `objects/${key.slice(0, 2)}/${key}`;
}

export function verifyArtifact(ref: ArtifactRef, bytes: Uint8Array): void {
  parseArtifactRef(ref);
  if (bytes.byteLength !== ref.bytes || sha256(bytes) !== ref.digest)
    throw new ResourceError('RESOURCE_INTEGRITY_FAILED', 'resource bytes do not match their reference');
}

/** The only generic CAS byte implementation. Policy and original retention live above this layer. */
export class ContentAddressedStorage {
  constructor(
    private readonly reader: ObjectReader,
    private readonly writer?: ConditionalObjectWriter,
  ) {}
  async read(ref: ArtifactRef, key = contentObjectKey(ref.digest)): Promise<Uint8Array | null> {
    const bytes = await this.reader.readRange(key, 0, ref.bytes + 1);
    if (bytes) verifyArtifact(ref, bytes);
    return bytes;
  }
  async ensure(
    ref: ArtifactRef,
    bytes: Uint8Array,
    key = contentObjectKey(ref.digest),
    metadata?: ObjectHttpMetadata,
  ): Promise<boolean> {
    if (!this.writer) throw new Error('content store is read-only');
    verifyArtifact(ref, bytes);
    const existing = await this.reader.stat(key);
    if (existing) {
      if (existing.size !== ref.bytes)
        throw new ResourceError('RESOURCE_INTEGRITY_FAILED', 'content object size conflict');
      const verified = await this.read(ref, key);
      if (!verified) throw new ResourceError('RESOURCE_BACKEND_UNAVAILABLE', 'content object disappeared', true);
      return false;
    }
    const created = await this.writer.create(
      key,
      bytes,
      metadata ?? { contentType: ref.mediaType, digest: ref.digest },
    );
    if (!created) {
      const winner = await this.read(ref, key);
      if (!winner)
        throw new ResourceError('RESOURCE_BACKEND_UNAVAILABLE', 'conditional content object disappeared', true);
    }
    return created;
  }
}
