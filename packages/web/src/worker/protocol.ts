import type {
  AssetBundle, AtlasIndex, BiomeMap, BlockInfoMap, DimensionDef, MeshBuffers, RenderLayer,
} from '@violet-map/core';

export interface WorkerInit {
  type: 'init';
  bundle: AssetBundle;
  blockInfo: BlockInfoMap;
  biomes: BiomeMap;
  atlasIndex: AtlasIndex;
  avgColors: Record<string, [number, number, number]>;
  grassColormap: Uint8Array | null;
  foliageColormap: Uint8Array | null;
}
export type WorkerRequest =
  | WorkerInit
  | { type: 'chunk'; key: string; cx: number; cz: number; dimension: DimensionDef; chunk: unknown }
  | { type: 'mesh'; key: string; version: number }
  | { type: 'lod'; key: string; step: number; version: number }
  | { type: 'drop'; key: string };

export interface SectionMeshMsg { sy: number; layers: Partial<Record<RenderLayer, MeshBuffers>> }
export type WorkerResponse =
  | { type: 'chunkReady'; key: string; biome: string; surfaceY: number }
  | { type: 'chunkError'; key: string; error: string }
  | { type: 'meshResult'; key: string; version: number; sections: SectionMeshMsg[] }
  | { type: 'lodResult'; key: string; version: number; mesh: MeshBuffers | null };

export const chunkKey = (world: string, dim: string, cx: number, cz: number) => `${world}|${dim}|${cx},${cz}`;
