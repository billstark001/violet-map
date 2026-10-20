import {
  type ArtifactRef,
  type ResourceKind,
  type ResourceRef,
  ResourceError,
  parseResourceRef,
} from '@violet-map/core/resources';
import { createPublicObjectUrl, publicObjectKey } from '@violet-map/storage';

type DeliveryOptions = { mode: 'server'; apiBasePath: string } | { mode: 'public'; publicBaseUrl: string };

export class ResourceDelivery {
  private readonly publicUrl?: (key: string) => string;
  constructor(private readonly options: DeliveryOptions) {
    if (options.mode === 'public') this.publicUrl = createPublicObjectUrl(options.publicBaseUrl);
    else if (
      options.mode !== 'server' ||
      !options.apiBasePath.startsWith('/') ||
      options.apiBasePath.startsWith('//') ||
      /[?#\\]/.test(options.apiBasePath)
    )
      throw new TypeError('invalid server resource base path');
  }
  resolve(viewId: string, kind: ResourceKind, artifact: ArtifactRef, published: boolean): ResourceRef {
    if (this.options.mode === 'public') {
      if (!published) throw new ResourceError('RESOURCE_NOT_PUBLISHED', 'resource is not in a committed publication');
      return parseResourceRef({ schemaVersion: 1, kind, artifact, url: this.publicUrl!(publicObjectKey(artifact)) });
    }
    return parseResourceRef({
      schemaVersion: 1,
      kind,
      artifact,
      url: `${this.options.apiBasePath.replace(/\/$/, '')}/${encodeURIComponent(viewId)}/${kind}/${artifact.digest}`,
    });
  }
}
