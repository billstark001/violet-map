import { encode } from '@msgpack/msgpack';
import { canonicalJson } from '@violet-map/core/resources';
import { sha256 } from '@violet-map/storage';

/** Source validators and transport batching never enter a chunk's immutable representation. */
export function prepareChunkArtifact(input: { cx: number; cz: number; data: Uint8Array; entities?: Uint8Array }) {
  const terrainHash = sha256(input.data),
    entityHash = input.entities ? sha256(input.entities) : undefined;
  const dependencies = [
    { role: 'terrain', digest: terrainHash },
    { role: 'entities', digest: entityHash ?? sha256('absent') },
  ];
  const fixed = Object.freeze({
    schemaVersion: 1,
    cx: input.cx,
    cz: input.cz,
    data: input.data,
    ...(input.entities ? { entities: input.entities } : {}),
  });
  return {
    terrainHash,
    entityHash,
    nbtHash: sha256(canonicalJson(dependencies)),
    dependencies,
    generate: () => encode(fixed),
  };
}
