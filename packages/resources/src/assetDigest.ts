import { canonicalJson, ResourceError } from '@violet-map/core/resources';
import { sha256 } from '@violet-map/storage';
import { LocalStorage } from '@violet-map/storage/local';
import { createHash } from 'node:crypto';

/** Ordered pack precedence is part of the dependency. File bytes are streamed under a fixed read bound. */
export async function assetDirectoryDigest(directories: readonly string[]) {
  const digest = createHash('sha256');
  let files = 0;
  for (const [pack, directory] of directories.entries()) {
    const reader = new LocalStorage(directory);
    const entries = await reader.list();
    if (entries.length > 32768) throw new ResourceError('RESOURCE_BUSY', 'asset inventory exceeds metadata budget');
    for (const entry of entries) {
      if (!/\.(json|png|mcmeta)$/.test(entry.path)) continue;
      if (++files > 32768) throw new ResourceError('RESOURCE_BUSY', 'asset inventory exceeds metadata budget');
      if (entry.size > 8 * 1024 ** 2) throw new ResourceError('RESOURCE_BUSY', 'asset input exceeds read budget');
      const bytes = await reader.readRange(entry.path, 0, entry.size + 1);
      if (!bytes || bytes.byteLength !== entry.size)
        throw new ResourceError('SOURCE_SNAPSHOT_CHANGED', 'asset changed during dependency scan', true);
      digest.update(canonicalJson({ pack, path: entry.path, digest: sha256(bytes) }));
    }
  }
  return digest.digest('hex');
}
