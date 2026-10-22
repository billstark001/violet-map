import type { OverlayManifest } from '@violet-map/core/overlays';

export interface OverlayDisplaySnapshot {
  features: number;
  active: number;
  suppressed: number;
  versions: number;
  pending: number;
  resourceBytes: number;
  maskBytes: number;
  maskLimited: boolean;
  samplingLimited: number;
  curvePoints: number;
  errors: { feature: string; message: string }[];
}

export interface OverlayDisplay {
  setEnabled(enabled: boolean): void;
  reset(): void;
  apply(manifest: OverlayManifest): void;
  diagnosticSnapshot(): OverlayDisplaySnapshot;
  dispose(): void;
}
