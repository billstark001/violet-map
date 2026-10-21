import { nonSharedByteView, readLimitedBody } from '@violet-map/core/http';
import { ResourceError, type ArtifactRef } from '@violet-map/core/resources';
import { publicObjectKey, representationKey, verifyArtifact } from './contentAddressed.js';
import { verifyPublicArtifact } from './publicArtifact.js';
import { createPublicObjectUrl } from './publicUrl.js';

/** Explicit HTTP CAS upload protocol, independent of all object SDKs and bucket names. */
export class StaticHttpPublisher {
  private readonly endpoint: (key: string) => string;
  private readonly publicUrl: (key: string) => string;
  constructor(
    baseUrl: string,
    publicBaseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 30000,
  ) {
    this.endpoint = createPublicObjectUrl(baseUrl);
    this.publicUrl = createPublicObjectUrl(publicBaseUrl);
    if (!token || /[\r\n]/.test(token)) throw new TypeError('HTTP CAS requires an upload credential');
  }
  async missing(keys: readonly string[]): Promise<Set<string>> {
    if (keys.length > 256 || keys.some((key) => !/^[a-f0-9]{64}$/.test(key)))
      throw new RangeError('invalid HTTP CAS missing batch');
    const response = await fetch(this.endpoint('v1/missing'), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ keys }),
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ResourceError('RESOURCE_BACKEND_UNAVAILABLE', 'HTTP CAS missing query failed', true);
    }
    const bytes = await readLimitedBody(response, 64 * 1024);
    if (!bytes) throw new ResourceError('RESOURCE_INTEGRITY_FAILED', 'HTTP CAS response exceeds limits');
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !value ||
      Object.keys(value).some((k) => k !== 'missing') ||
      !Array.isArray(value.missing) ||
      value.missing.some((key: unknown) => typeof key !== 'string' || !keys.includes(key)) ||
      new Set(value.missing).size !== value.missing.length
    )
      throw new ResourceError('UNSUPPORTED_RESOURCE_FORMAT', 'invalid HTTP CAS missing response');
    return new Set(value.missing);
  }
  async ensure(ref: ArtifactRef, bytes: Uint8Array): Promise<boolean> {
    verifyArtifact(ref, bytes);
    if (!(await this.missing([representationKey(ref)])).has(representationKey(ref))) return false;
    const response = await fetch(this.endpoint(`v1/objects/${representationKey(ref)}`), {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': ref.mediaType,
        'if-none-match': '*',
        'x-content-sha256': ref.digest,
        'cache-control': 'public, max-age=31536000, immutable',
      },
      body: nonSharedByteView(bytes),
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    await response.body?.cancel();
    if (response.status === 412) {
      await verifyPublicArtifact(ref, this.publicUrl(publicObjectKey(ref)), {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return false;
    }
    if (response.status !== 201 && response.status !== 204)
      throw new ResourceError('RESOURCE_BACKEND_UNAVAILABLE', 'HTTP CAS atomic upload failed', true);
    await verifyPublicArtifact(ref, this.publicUrl(publicObjectKey(ref)), {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return true;
  }
}
