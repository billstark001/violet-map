import type { ObjectStorage } from '@violet-map/core/storage';

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('');
}

export async function compareObjectContent(
  source: ObjectStorage,
  target: ObjectStorage,
  path: string,
  sourceSize: number,
): Promise<{ same: boolean; sourceBytes: Uint8Array | null }> {
  const targetInfo = await target.stat(path);
  if (!targetInfo || targetInfo.size !== sourceSize) return { same: false, sourceBytes: null };
  const [from, to] = await Promise.all([source.read(path), target.read(path)]);
  if (!from) throw new Error(`source file disappeared during sync: ${path}`);
  if (!to) return { same: false, sourceBytes: from };
  const [sourceHash, targetHash] = await Promise.all([sha256(from), sha256(to)]);
  return { same: sourceHash === targetHash, sourceBytes: from };
}

export async function copyObjects(
  source: ObjectStorage,
  target: ObjectStorage,
  options: {
    dryRun?: boolean;
    deleteExtra?: boolean;
    exclude?: string[];
    onProgress?: (event: { type: 'copy' | 'skip' | 'delete'; path: string }) => void;
  } = {},
) {
  const excluded = new Set(options.exclude);
  const files = (await source.list()).filter((file) => !excluded.has(file.path));
  const result = { copied: [] as string[], skipped: [] as string[], deleted: [] as string[] };
  for (const file of files) {
    const comparison = await compareObjectContent(source, target, file.path, file.size);
    const type = comparison.same ? 'skip' : 'copy';
    if (!comparison.same && !options.dryRun) {
      const bytes = comparison.sourceBytes ?? (await source.read(file.path));
      if (!bytes) throw new Error(`source object disappeared: ${file.path}`);
      await target.write(file.path, bytes);
    }
    result[comparison.same ? 'skipped' : 'copied'].push(file.path);
    options.onProgress?.({ type, path: file.path });
  }
  if (options.deleteExtra) {
    const wanted = new Set(files.map((file) => file.path));
    for (const file of await target.list()) {
      if (excluded.has(file.path) || wanted.has(file.path)) continue;
      if (!options.dryRun) await target.delete(file.path);
      result.deleted.push(file.path);
      options.onProgress?.({ type: 'delete', path: file.path });
    }
  }
  return result;
}
