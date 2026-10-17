import type { RenderLayer } from '@violet-map/core/assets';

export interface MeshBuffers {
  positions: Uint16Array;
  uvs?: Uint16Array;
  atlasRects?: Uint16Array;
  colors: Uint8Array;
  lights: Uint8Array;
  /** Per-vertex animated-sprite id. Omitted entirely when a mesh is static. */
  animations?: Uint16Array;
  indices: Uint16Array | Uint32Array;
  bounds?: { min: [number, number, number]; max: [number, number, number] };
}

export type SectionMeshes = Partial<Record<RenderLayer, MeshBuffers>>;
