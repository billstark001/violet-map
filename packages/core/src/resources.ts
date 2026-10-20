import type { ArtifactRef, PublicationEntry } from './resourceTypes.js';

export { canonicalJson } from './resourceCanonical.js';
export type * from './resourceTypes.js';

export { parseArtifactRef, parseResourceRef, parseResourceViewHead, ResourceError } from './resourceContracts.js';

export interface PublicationManifest {
  schemaVersion: 1;
  sourceScope: string;
  archiveIds: Record<string, string>;
  sourceScopes: Record<string, string>;
  renderRoot: string;
  worlds: import('./contracts.js').WorldInfo[];
  entries: PublicationEntry[];
  regions: { world: string; dimension: string; rx: number; rz: number; artifact: ArtifactRef }[];
  coverage: Record<string, import('./contracts.js').ChunkCoverage>;
  topMaps: Record<string, import('./contracts.js').TopMapDimensionManifest>;
  overlays: import('./overlayTypes.js').OverlaySnapshot[];
}

export { parseResourceSelector } from './resourceContracts.js';

export { mediaArtifact, parseResolvedResource } from './resourceContracts.js';
