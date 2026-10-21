import { readLimitedBody } from '@violet-map/core/http';
import { parseArtifactRef, ResourceError, type ArtifactRef } from '@violet-map/core/resources';
import { verifyArtifact } from './contentAddressed.js';

/** Verify the anonymous download channel, with optional browser-origin policy. */
export async function verifyPublicArtifact(
  ref: ArtifactRef,
  url: string,
  options: { origin?: string; signal?: AbortSignal } = {},
): Promise<void> {
  parseArtifactRef(ref);
  const response = await fetch(url, {
    headers: options.origin ? { origin: options.origin } : {},
    credentials: 'omit',
    redirect: 'error',
    signal: options.signal ?? AbortSignal.timeout(30000),
  });
  const cors = response.headers.get('access-control-allow-origin');
  const cache = response.headers
    .get('cache-control')
    ?.split(',')
    .map((value) => value.trim().toLowerCase());
  if (
    response.status !== 200 ||
    response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== ref.mediaType ||
    !cache?.includes('immutable') ||
    (options.origin !== undefined && cors !== '*' && cors !== options.origin)
  ) {
    await response.body?.cancel();
    throw new ResourceError('RESOURCE_INTEGRITY_FAILED', 'public resource HTTP/CORS contract failed');
  }
  const bytes = await readLimitedBody(response, ref.bytes);
  if (!bytes) throw new ResourceError('RESOURCE_INTEGRITY_FAILED', 'public resource exceeds declared byte size');
  verifyArtifact(ref, bytes);
}
