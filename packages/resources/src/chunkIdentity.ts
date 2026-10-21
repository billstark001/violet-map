import { canonicalJson } from '@violet-map/core/resources';
import { sha256 } from '@violet-map/storage';

/** Digests describe decoded content; source validators never enter this identity. */
export function chunkIdentity(data: Uint8Array, entities?: Uint8Array) {
  const terrainDigest = sha256(data),
    entityDigest = entities ? sha256(entities) : undefined;
  const dependencies = [
    { role: 'terrain', digest: terrainDigest },
    { role: 'entities', digest: entityDigest ?? sha256('absent') },
  ];
  return {
    terrainDigest,
    ...(entityDigest ? { entityDigest } : {}),
    contentDigest: sha256(canonicalJson(dependencies)),
  };
}
