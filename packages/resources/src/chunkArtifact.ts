import { encode } from '@msgpack/msgpack';
import { sha256 } from '@violet-map/storage';
import type { ChunkContentIdentity } from '@violet-map/core/resources';

/** Source validators and transport batching never enter a chunk's immutable representation. */
export function prepareChunkArtifact(
  input: { cx: number; cz: number; data: Uint8Array; entities?: Uint8Array },
  identity: ChunkContentIdentity,
) {
  const dependencies = [
    { role: 'terrain', digest: identity.terrainDigest },
    { role: 'entities', digest: identity.entityDigest ?? sha256('absent') },
  ];
  const fixed = Object.freeze({
    schemaVersion: 1,
    cx: input.cx,
    cz: input.cz,
    data: input.data,
    ...(input.entities ? { entities: input.entities } : {}),
  });
  return {
    ...identity,
    dependencies,
    generate: () => encode(fixed),
  };
}
