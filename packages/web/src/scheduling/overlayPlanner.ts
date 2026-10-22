import type { OverlayFeature, OverlayManifest } from '@violet-map/core/overlays';

export function planOverlayFeatures(
  manifest: OverlayManifest,
): { key: string; feature: OverlayFeature; order: number }[] {
  if (manifest.sourceStatus !== 'verified' && manifest.sourceStatus !== 'unverified') return [];
  const layers = [...manifest.layers].sort(
    (a, b) => a.binding.order - b.binding.order || a.binding.bindingId.localeCompare(b.binding.bindingId),
  );
  const features = [];
  for (const layer of layers)
    for (const feature of [...layer.document.features].sort((a, b) => a.featureId.localeCompare(b.featureId)))
      features.push({
        key: layer.binding.bindingId + '/' + layer.document.layerId + '/' + feature.featureId,
        feature,
        order: features.length,
      });
  return features;
}

export interface OverlayAdmissionLimits {
  activeFeatures: number;
  curvePointsPerFeature: number;
  curvePointsTotal: number;
  curveDepth: number;
  curveToleranceCssPixels: number;
}

export interface OverlayCandidate {
  key: string;
  feature: OverlayFeature;
  spatiallyVisible: boolean;
  retryAt: number | undefined;
  active: boolean;
  curvePoints: number;
}

export interface OverlayAdmission {
  key: string;
  activate: boolean;
  sample: boolean;
}

/** Input order is the explicit layer/feature order, including under pressure. */
export function planOverlayAdmission(
  candidates: Iterable<OverlayCandidate>,
  frame: { now: number; topView: boolean; projectionChanged: boolean },
  limits: OverlayAdmissionLimits,
): { admitted: OverlayAdmission[]; release: string[]; suppressed: number } {
  const admitted: OverlayAdmission[] = [];
  const release: string[] = [];
  let active = 0;
  let suppressed = 0;
  for (const candidate of candidates) {
    const feature = candidate.feature;
    const styleAllows =
      feature.kind === 'media'
        ? feature.views.includes(frame.topView ? 'top' : 'player')
        : feature.kind === 'curve'
          ? feature.style.opacity > 0
          : (frame.topView ? feature.fill.opacity : feature.wall.opacity) > 0;
    if (!candidate.spatiallyVisible || !styleAllows) {
      release.push(candidate.key);
      continue;
    }
    if (active >= limits.activeFeatures) {
      suppressed++;
      release.push(candidate.key);
      continue;
    }
    active++;
    if (candidate.retryAt !== undefined && frame.now < candidate.retryAt) continue;
    admitted.push({
      key: candidate.key,
      activate: !candidate.active,
      sample: feature.kind === 'curve' && (frame.projectionChanged || candidate.curvePoints === 0),
    });
  }
  return { admitted, release, suppressed };
}

/** Evaluated after preceding samples commit, so every frame shares one point budget. */
export function curveSamplingBudget(
  totalPoints: number,
  featurePoints: number,
  limits: OverlayAdmissionLimits,
): { tolerance: number; maxDepth: number; maxPoints: number } {
  return {
    tolerance: limits.curveToleranceCssPixels,
    maxDepth: limits.curveDepth,
    maxPoints: Math.min(
      limits.curvePointsPerFeature,
      Math.max(0, limits.curvePointsTotal - totalPoints + featurePoints),
    ),
  };
}
