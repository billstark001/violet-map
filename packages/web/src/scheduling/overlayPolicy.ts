import type { OverlayAdmissionLimits } from './overlayPlanner';

export const OVERLAY_ADMISSION_LIMITS: Readonly<OverlayAdmissionLimits> = Object.freeze({
  activeFeatures: 512,
  curvePointsPerFeature: 65_536,
  curvePointsTotal: 200_000,
  curveDepth: 18,
  curveToleranceCssPixels: 0.5,
});

export const OVERLAY_REFRESH_MS = 30_000;
export const OVERLAY_RETRY_MS = 12_000;
