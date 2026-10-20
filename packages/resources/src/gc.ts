import { publicObjectKey, sha256 } from '@violet-map/storage';
import type { PublicationStore } from './publication.js';
import type { PublicTarget } from './publicTarget.js';

/** A bounded conservative mark set: collisions retain garbage and can never delete live content. */
class Marks {
  private readonly bits: Uint8Array;
  constructor(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 1024) throw new RangeError('GC metadata budget too small');
    this.bits = new Uint8Array(bytes);
  }
  private positions(key: string) {
    const hash = sha256(key);
    return [0, 8, 16, 24].map((offset) => Number.parseInt(hash.slice(offset, offset + 8), 16) % (this.bits.length * 8));
  }
  add(key: string) {
    for (const bit of this.positions(key)) this.bits[bit >> 3] |= 1 << (bit & 7);
  }
  has(key: string) {
    return this.positions(key).every((bit) => Boolean(this.bits[bit >> 3] & (1 << (bit & 7))));
  }
}

export async function collectPublicationGarbage(
  store: PublicationStore,
  target: PublicTarget,
  options: { metadataBytes: number; retainedMs: number; orphanMs?: number },
) {
  const orphanMs = options.orphanMs ?? 86400000;
  if (options.retainedMs < 604800000 || orphanMs < 86400000)
    throw new RangeError('publication retention cannot be shorter than its read promise');
  await store.acquire();
  await store.assertWriter();
  const current = await store.head();
  const marks = new Marks(Math.floor(options.metadataBytes / 4));
  let roots = 0,
    marked = 0,
    deleted = 0,
    deletedBytes = 0,
    controlDeleted = 0;
  const artifact = (ref: import('@violet-map/core/resources').ArtifactRef) => {
    marks.add('public:' + publicObjectKey(ref));
    marked++;
  };
  for await (const root of store.roots(options.retainedMs, orphanMs)) {
    roots++;
    marks.add('control:manifests/' + root.ref.digest + '.json');
    for (const entry of root.manifest.entries) {
      artifact(entry.artifact);
      if (entry.image) artifact(entry.image);
    }
    for (const region of root.manifest.regions) {
      marks.add('control:indexes/' + region.artifact.digest + '.json');
      for (const entry of (await store.page(region.artifact)).chunks) artifact(entry.artifact);
    }
  }
  for await (const object of target.inventory())
    if (
      !marks.has('public:' + object.path) &&
      object.modifiedAt !== undefined &&
      Date.now() - object.modifiedAt >= orphanMs
    ) {
      await store.assertWriter();
      if ((await store.head())?.publicationId !== current?.publicationId)
        throw new Error('publication roots changed during GC');
      await target.deleteObject(object.path);
      deleted++;
      deletedBytes += object.size;
    }
  for (const prefix of ['indexes', 'manifests'])
    for await (const object of store.inventory(prefix))
      if (
        !marks.has('control:' + object.path) &&
        object.modifiedAt !== undefined &&
        Date.now() - object.modifiedAt >= orphanMs
      ) {
        await store.deleteControl(object.path);
        controlDeleted++;
      }
  return {
    roots,
    marked,
    deleted,
    deletedBytes,
    controlDeleted,
    markBytes: Math.floor(options.metadataBytes / 4),
    conservative: true,
  };
}
