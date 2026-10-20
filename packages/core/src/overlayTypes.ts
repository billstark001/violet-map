export type Vec2 = [number, number];

export type Vec3 = [number, number, number];

export type ViewMode = 'top' | 'player';

export interface ColorStyle {
  color: string;
  opacity: number;
}

export interface CurveFeature {
  featureId: string;
  kind: 'curve';
  nodes: { anchor: Vec3; in: Vec3; out: Vec3 }[];
  closed: boolean;
  style: ColorStyle & { width: number; widthUnit: 'blocks' | 'pixels' };
}

export interface AreaFeature {
  featureId: string;
  kind: 'area';
  ring: Vec2[];
  minY: number;
  maxY: number;
  fill: ColorStyle;
  wall: ColorStyle & { occlusion: 'terrain' | 'always' };
}

export interface MediaFeature {
  featureId: string;
  kind: 'media';
  assetId: string;
  versionId: string;
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
  views: ViewMode[];
  lighting?: 'label' | 'scene';
  placement: 'model' | 'plane' | 'billboard' | 'upright';
  size?: Vec2;
  anchor?: Vec2;
}

export type OverlayFeature = CurveFeature | AreaFeature | MediaFeature;

export interface LayerDocument {
  schemaVersion: 1;
  layerId: string;
  revision: number;
  name: string;
  features: OverlayFeature[];
}

export interface LayerBinding {
  bindingId: string;
  dimension: string;
  layerId: string;
  enabled: boolean;
  order: number;
}

export interface MapDocument {
  schemaVersion: 1;
  mapId: string;
  revision: number;
  name: string;
  worldKey: string | null;
  expectedArchiveId?: string;
  bindings: LayerBinding[];
}

export type MapSourceStatus = 'verified' | 'unverified' | 'missing' | 'mismatch' | 'unbound';

export interface MediaVersion {
  schemaVersion: 1;
  assetId: string;
  versionId: string;
  digest: string;
  bytes: number;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml' | 'model/gltf-binary';
  width?: number;
  height?: number;
  bounds?: { min: Vec3; max: Vec3 };
  dependencies: [];
  blob: string;
}

export interface MediaDocument {
  schemaVersion: 1;
  assetId: string;
  revision: number;
  name: string;
  versions: string[];
}

export interface OverlayMediaReference {
  version: MediaVersion;
  /** API-relative authenticated/public-scope proxy, always available. */
  url: string;
  /** Optional anonymous HTTP(S) object URL; the pinned digest still applies. */
  publicUrl?: string;
}

export interface OverlayManifest {
  schemaVersion: 1;
  mapId: string;
  mapRevision: number;
  dimension: string;
  sourceStatus: MapSourceStatus;
  layers: { binding: LayerBinding; document: LayerDocument }[];
  media: OverlayMediaReference[];
}

export interface OverlaySnapshot extends Omit<OverlayManifest, 'schemaVersion' | 'media'> {
  media: MediaVersion[];
}
