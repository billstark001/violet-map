import type {
  AssetBundle, AtlasIndex, BiomeMap, BlockInfoMap, DimensionDef, MeshBuffers, RenderLayer, TextureAlphaMap,
} from '@violet-map/core';

export interface WorkerInit {
  type: 'init';
  bundle: AssetBundle;
  blockInfo: BlockInfoMap;
  biomes: BiomeMap;
  atlasIndex: AtlasIndex;
  avgColors: Record<string, [number, number, number]>;
  textureHasAlpha: TextureAlphaMap;
  grassColormap: Uint8Array | null;
  foliageColormap: Uint8Array | null;
}
export type WorkerRequest =
  | WorkerInit
  | { type: 'chunk'; key: string; cx: number; cz: number; dimension: DimensionDef; chunk: ArrayBuffer }
  | { type: 'mesh'; key: string; version: number }
  | { type: 'lod'; key: string; step: number; version: number }
  | { type: 'drop'; key: string };

export interface SectionMeshMsg { sy: number; layers: Partial<Record<RenderLayer, MeshBuffers>>; visibility?: number }
export interface LodMeshMsg { step: number; mesh: MeshBuffers | null }

export interface WorkerChunkProfile {
  chunkBytes: number;
  parseMs: number;
  storedColumns: number;
}

export interface WorkerMeshProfile {
  meshBytes: number;
  meshMs: number;
  storedColumns: number;
  sectionCount?: number;
}

export type WorkerResponse =
  | { type: 'chunkReady'; key: string; biome: string; surfaceY: number; profile?: WorkerChunkProfile }
  | { type: 'chunkError'; key: string; error: string }
  | { type: 'meshResult'; key: string; version: number; sections: SectionMeshMsg[]; profile?: WorkerMeshProfile }
  | {
    type: 'lodResult';
    key: string;
    version: number;
    step: number;
    mesh: MeshBuffers | null;
    meshes?: LodMeshMsg[];
    profile?: WorkerMeshProfile;
  };

export const chunkKey = (world: string, dim: string, cx: number, cz: number) => `${world}|${dim}|${cx},${cz}`;
