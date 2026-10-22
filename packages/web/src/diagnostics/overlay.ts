import type { OverlayDisplaySnapshot } from '../runtime/overlayDisplay';

export interface OverlayDiagnosticSnapshot extends OverlayDisplaySnapshot {
  mapId: string | null;
  dimension: string;
  enabled: boolean;
  loading: boolean;
  sourceStatus: string | null;
}
