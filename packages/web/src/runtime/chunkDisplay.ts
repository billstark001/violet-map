import type { ViewState } from '../view/state';
import type { TopClipRange } from '../view/worldGeometry';
import type { ChunkDisplayState, LodStep, TerrainChunk, TerrainMesh } from '../view/terrain';

export interface ChunkDisplay {
  readonly meshBytes: number;
  readonly view: { topDownView: boolean; topClipRange: TopClipRange };
  setView(view: ViewState): void;
  updateVisibility(fullDetailKeys: ReadonlySet<string>): void;
  updateSurface(key: string, surfaceY: number): void;
  replace(chunk: TerrainChunk, mesh: TerrainMesh, version: number, step: LodStep): ChunkDisplayState;
  remove(key: string): void;
  hasVisibleMesh(key: string): boolean;
  displayedChunkKeys(): ReadonlySet<string>;
  dispose(): void;
}
