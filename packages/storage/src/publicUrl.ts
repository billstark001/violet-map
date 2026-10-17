import { publicResourceUrl } from '@violet-map/core/http';
import { cleanStoragePath } from './paths.js';

/** Resolve object keys below a public mount root, encoding each path segment.
 * The base must already include its public mount prefix; this does not sign URLs,
 * expose a bucket, or grant access to an otherwise private object. */
export function createPublicObjectUrl(baseUrl: string): (key: string) => string {
  const base = new URL(publicResourceUrl(baseUrl));
  if (base.search) throw new TypeError('public object base URL must not contain a query');
  base.pathname = base.pathname.replace(/\/+$/, '') + '/';
  return (key) => {
    const path = cleanStoragePath(key);
    if (!path) throw new TypeError('public object key must not be empty');
    return new URL(path.split('/').map(encodeURIComponent).join('/'), base).href;
  };
}
