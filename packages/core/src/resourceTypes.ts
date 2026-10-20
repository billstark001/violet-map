export type Sha256 = string;

export type ResourceKind =
  | 'chunk'
  | 'texture'
  | 'atlas-image'
  | 'atlas-manifest'
  | 'asset-bundle'
  | 'game-data'
  | 'top-map-tile'
  | 'overlay-media';

export interface ArtifactRef {
  digest: Sha256;
  bytes: number;
  mediaType: string;
  format: string;
}

export interface ResourceRef {
  schemaVersion: 1;
  kind: ResourceKind;
  artifact: ArtifactRef;
  url: string;
}

interface ViewBase {
  schemaVersion: 1;
  viewId: string;
  sourceScope: string;
  generation: number;
  renderRoot: Sha256;
}

export type ResourceViewHead = ViewBase & ({ mode: 'server' } | { mode: 'public'; publicationId: Sha256 });

export interface SourceRevision {
  token: string;
  strength: 'immutable' | 'conditional' | 'weak';
}

export type ResourceErrorCode =
  | 'RESOURCE_VIEW_EXPIRED'
  | 'RESOURCE_NOT_PUBLISHED'
  | 'RESOURCE_BUSY'
  | 'SOURCE_SNAPSHOT_CHANGED'
  | 'SOURCE_REVISION_UNAVAILABLE'
  | 'RESOURCE_BACKEND_UNAVAILABLE'
  | 'TOPMAP_REBAKE_REQUIRED'
  | 'RESOURCE_INTEGRITY_FAILED'
  | 'UNSUPPORTED_RESOURCE_FORMAT'
  | 'PUBLICATION_CONFLICT';

export type ResourceSelector =
  | { kind: 'chunk'; world: string; dimension: string; cx: number; cz: number }
  | { kind: 'atlas'; textureSetId: string }
  | { kind: 'texture'; id: string }
  | { kind: 'asset-bundle' }
  | { kind: 'game-data'; name: 'blocks' | 'biomes' | 'dimensions' }
  | { kind: 'top-map-tile'; world: string; dimension: string; rx: number; rz: number }
  | { kind: 'overlay-media'; mapId: string; dimension: string; assetId: string; versionId: string };

export type ResolvedResource =
  | { selector: ResourceSelector; missing: true }
  | { selector: ResourceSelector; resource: ResourceRef; nbtHash?: string; terrainHash?: string; entityHash?: string }
  | { selector: ResourceSelector; manifest: ResourceRef; image: ResourceRef };

export interface ResourceResolveBatch {
  viewId: string;
  validUntil: number;
  resources: ResolvedResource[];
}

export interface PublicationEntry {
  selector: ResourceSelector;
  artifact: ArtifactRef;
  actionKey: string;
  image?: ArtifactRef;
  nbtHash?: string;
  terrainHash?: string;
  entityHash?: string;
}

export interface RegionResourcePage {
  schemaVersion: 1;
  world: string;
  dimension: string;
  rx: number;
  rz: number;
  chunks: PublicationEntry[];
}

export interface PublicationHead {
  schemaVersion: 1;
  publicationId: string;
  revision: number;
  manifest: ArtifactRef;
}
