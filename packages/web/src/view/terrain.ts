import type { RenderLayer } from '@violet-map/core/assets';
import type { MeshBuffers } from '@violet-map/render';

export const LOD_STEPS = [1, 2, 4, 8] as const;

export type LodStep = (typeof LOD_STEPS)[number];

export type MeshTaskKind = 'full' | 'lod';

export interface SectionMesh {
  sy: number;
  layers: Partial<Record<RenderLayer, MeshBuffers>>;
  visibility: number;
}

export type TerrainMesh = { mode: 'full'; sections: SectionMesh[] } | { mode: 'lod'; mesh: MeshBuffers | null };

export interface TerrainChunk {
  key: string;
  cx: number;
  cz: number;
  surfaceY: number;
}

export interface ChunkDisplayState {
  displayed: 'none' | 'full' | 'lod';
  displayedVersion: number;
  displayedLodStep: number;
  fullReady: boolean;
  lodReadyStep: number;
  meshBytes: number;
}

export const EMPTY_CHUNK_DISPLAY: Readonly<ChunkDisplayState> = Object.freeze({
  displayed: 'none',
  displayedVersion: -1,
  displayedLodStep: 0,
  fullReady: false,
  lodReadyStep: 0,
  meshBytes: 0,
});
