import type { AssetPack } from './assetPack.js';
import type { ArtifactRead } from './blobRepository.js';

export interface ResourceEngineConfig {
  resources: {
    roles: ('serve' | 'publish')[];
    cache: { metadataBytes: number };
    work: { handoffMs: number; maxTasks: number };
    source: { scope: string; consistency: 'snapshot' | 'bounded'; revalidateMs: number };
    publication: { debounceMs: number; maxDelayMs: number; retainedMs: number; warmup?: 'manual' | 'startup' };
    delivery: { mode: 'server' | 'public'; publicBaseUrl: string | null };
  };
  sourceIdentity: string;
}

export interface ResourceEngineMounts {
  metrics?(): unknown;
  worlds?: import('@violet-map/core/storage').ObjectReader;
  resourceTarget?: import('@violet-map/core/storage').ObjectReader;
}

export interface GameDataSource {
  buildBlockInfo(): Promise<import('@violet-map/core/assets').BlockInfoMap>;
  readBiomes(): Promise<import('@violet-map/core/domain').BiomeMap>;
  readDimensions(): Promise<import('@violet-map/core/domain').DimensionMap>;
}

export interface TopMapSource {
  getTopMapManifest(world: string): Promise<import('@violet-map/core/formats/top-map').TopMapManifest | null>;
  readTopMapTile(world: string, dim: string, rx: number, rz: number): Promise<Uint8Array | null>;
}

export interface ContentSource {
  openPublicMedia(
    mapId: string,
    dimension: string,
    assetId: string,
    versionId: string,
  ): Promise<{
    version: import('@violet-map/core/overlays').MediaVersion;
    read(range?: { start: number; end: number }): Promise<ArtifactRead>;
  }>;
  snapshot(mapId: string, dimension: string): Promise<import('@violet-map/core/overlays').OverlaySnapshot>;
  listMaps(): Promise<import('@violet-map/core/overlays').MapDocument[]>;
}

export interface DynamicSources {
  assets: AssetPack;
  worldStore: Pick<
    import('./sources/worldChunks.js').WorldSource,
    'listWorlds' | 'listChunkSourceCoverage' | 'readChunks' | 'invalidateStoredFile'
  >;
  topMap: TopMapSource;
  gameData: GameDataSource;
}
