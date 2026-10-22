import { clampFinite, diskCellCount } from './chunkPolicy';
import { type ChunkSchedulingTuning } from './contracts';

export const SCHEDULER_PRESETS = ['potato', 'low', 'medium', 'high', 'extreme'] as const;

export type SchedulerPreset = (typeof SCHEDULER_PRESETS)[number];

function presetRadius(viewDistance: number, lodDistance: number, min: number, max: number, scale: number): number {
  const view = Number.isFinite(viewDistance) ? Math.max(0, viewDistance) : 0;
  const lod = Number.isFinite(lodDistance) ? Math.max(0, lodDistance) : 0;
  const requested = Math.max(2, Math.ceil(view + lod));
  return Math.max(min, Math.min(max, Math.ceil(requested * scale)));
}

/**
 * Scheduling profiles control throughput and retention. View distance controls
 * full-detail quality for every profile, independently of tracker satisfaction.
 */
export function schedulerTuningForPreset(
  preset: SchedulerPreset,
  viewDistance: number,
  lodDistance: number,
): ChunkSchedulingTuning {
  // View distance is a quality contract, independent of load/completion state.
  const fullDetailRadiusChunks = Math.floor(clampFinite(viewDistance, 8, 2, 32));
  const fullDetailCells = diskCellCount(fullDetailRadiusChunks);
  switch (preset) {
    case 'potato': {
      const activeRadiusChunks = Math.max(fullDetailRadiusChunks, presetRadius(viewDistance, lodDistance, 8, 12, 0.5));
      return {
        activeRadiusChunks,
        maxCandidates: 256,
        maxFrameCandidates: 32,
        maxTrackedChunks: Math.max(128, fullDetailCells),
        fullDetailRadiusChunks,
        nearPresenceRadiusChunks: Math.max(fullDetailRadiusChunks, 4),
        tauImportance: 0.42,
        nearImportanceHalfLife: 0.48,
        farImportanceHalfLife: 0.06,
        importanceDecayDistancePower: 1.9,
        tauSatisfaction: 0.8,
        angleSigmaRad: 0.62,
        fovRadiusRad: null,
        distanceWeightPower: 0.8,
        distanceInverseSquareRadiusChunks: Math.max(3, activeRadiusChunks * 0.28),
        overshootEta: 0.08,
        neighborPrecisionEpsilon: 1e-6,
        neighborSatisfactionPenaltyByCount: [0, 0, 0.025, 0.05, 0.09, 0.14, 0.2, 0.28, 0.36],
        minSatisfaction: -0.36,
        minImportanceToSchedule: 0.016,
        minGapToSchedule: 0.026,
      };
    }
    case 'low': {
      const activeRadiusChunks = Math.max(
        fullDetailRadiusChunks,
        presetRadius(viewDistance, lodDistance, 12, 20, 0.75),
      );
      return {
        activeRadiusChunks,
        maxCandidates: 512,
        maxFrameCandidates: 56,
        maxTrackedChunks: Math.max(256, fullDetailCells),
        fullDetailRadiusChunks,
        nearPresenceRadiusChunks: Math.max(fullDetailRadiusChunks, 6),
        tauImportance: 0.5,
        nearImportanceHalfLife: 0.6,
        farImportanceHalfLife: 0.09,
        importanceDecayDistancePower: 1.65,
        tauSatisfaction: 1.0,
        angleSigmaRad: 0.7,
        fovRadiusRad: null,
        distanceWeightPower: 0.72,
        distanceInverseSquareRadiusChunks: Math.max(6, activeRadiusChunks * 0.34),
        overshootEta: 0.1,
        neighborPrecisionEpsilon: 1e-6,
        neighborSatisfactionPenaltyByCount: [0, 0, 0.03, 0.065, 0.11, 0.17, 0.24, 0.33, 0.43],
        minSatisfaction: -0.43,
        minImportanceToSchedule: 0.012,
        minGapToSchedule: 0.02,
      };
    }
    case 'high': {
      const activeRadiusChunks = Math.max(
        fullDetailRadiusChunks,
        presetRadius(viewDistance, lodDistance, 24, 48, 1.25),
      );
      return {
        activeRadiusChunks,
        maxCandidates: Math.max(1536, activeRadiusChunks * 36),
        maxFrameCandidates: 160,
        maxTrackedChunks: Math.max(640, fullDetailCells),
        fullDetailRadiusChunks,
        nearPresenceRadiusChunks: Math.max(fullDetailRadiusChunks, 10),
        tauImportance: 0.85,
        nearImportanceHalfLife: 1.0,
        farImportanceHalfLife: 0.2,
        importanceDecayDistancePower: 1.25,
        tauSatisfaction: 1.8,
        angleSigmaRad: 0.95,
        fovRadiusRad: null,
        distanceWeightPower: 0.55,
        distanceInverseSquareRadiusChunks: Math.max(12, activeRadiusChunks * 0.5),
        overshootEta: 0.16,
        neighborPrecisionEpsilon: 1e-6,
        neighborSatisfactionPenaltyByCount: [0, 0, 0.045, 0.095, 0.16, 0.24, 0.34, 0.46, 0.58],
        minSatisfaction: -0.58,
        minImportanceToSchedule: 0.004,
        minGapToSchedule: 0.006,
      };
    }
    case 'extreme': {
      const activeRadiusChunks = Math.max(fullDetailRadiusChunks, presetRadius(viewDistance, lodDistance, 32, 64, 1.5));
      return {
        activeRadiusChunks,
        maxCandidates: Math.max(2304, activeRadiusChunks * 40),
        maxFrameCandidates: 256,
        maxTrackedChunks: Math.max(1024, fullDetailCells),
        fullDetailRadiusChunks,
        nearPresenceRadiusChunks: Math.max(fullDetailRadiusChunks, 12),
        tauImportance: 1.2,
        nearImportanceHalfLife: 1.5,
        farImportanceHalfLife: 0.32,
        importanceDecayDistancePower: 1.1,
        tauSatisfaction: 2.5,
        angleSigmaRad: 1.2,
        fovRadiusRad: null,
        distanceWeightPower: 0.45,
        distanceInverseSquareRadiusChunks: Math.max(16, activeRadiusChunks * 0.6),
        overshootEta: 0.2,
        neighborPrecisionEpsilon: 1e-6,
        neighborSatisfactionPenaltyByCount: [0, 0, 0.05, 0.11, 0.18, 0.28, 0.4, 0.54, 0.68],
        minSatisfaction: -0.68,
        minImportanceToSchedule: 0.002,
        minGapToSchedule: 0.003,
      };
    }
    case 'medium':
    default: {
      const activeRadiusChunks = Math.max(fullDetailRadiusChunks, presetRadius(viewDistance, lodDistance, 8, 32, 1));
      return {
        activeRadiusChunks,
        maxCandidates: Math.min(1536, Math.max(896, activeRadiusChunks * 32)),
        maxFrameCandidates: Math.min(112, Math.max(72, Math.ceil(activeRadiusChunks * 2.5))),
        maxTrackedChunks: Math.max(384, fullDetailCells),
        fullDetailRadiusChunks,
        nearPresenceRadiusChunks: Math.max(fullDetailRadiusChunks, 8),
        tauImportance: 0.6,
        nearImportanceHalfLife: 0.72,
        farImportanceHalfLife: 0.12,
        importanceDecayDistancePower: 1.45,
        tauSatisfaction: 1.25,
        angleSigmaRad: 0.8,
        fovRadiusRad: null,
        distanceWeightPower: 0.65,
        distanceInverseSquareRadiusChunks: Math.max(10, activeRadiusChunks * 0.4),
        overshootEta: 0.12,
        neighborPrecisionEpsilon: 1e-6,
        neighborSatisfactionPenaltyByCount: [0, 0, 0.04, 0.085, 0.14, 0.21, 0.3, 0.4, 0.52],
        minSatisfaction: -0.52,
        minImportanceToSchedule: 0.008,
        minGapToSchedule: 0.014,
      };
    }
  }
}
