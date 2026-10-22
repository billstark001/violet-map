import {
  type ChunkSchedulingTuning,
  type ResolvedChunkScheduling,
  type ChunkSchedulerEntry,
  type ChunkPriority,
  type MeshTask,
  type ChunkDemand,
} from './contracts';
import { LOD_STEPS, type LodStep } from '../view/terrain';

import { CHUNK_SIZE_BLOCKS, WORLD_MIN_Y, WORLD_MAX_Y } from '../view/worldGeometry';

export const DEFAULT_ACTIVE_RADIUS_CHUNKS = 32;

export const MIN_ACTIVE_RADIUS_CHUNKS = 8;

export const MAX_ACTIVE_RADIUS_CHUNKS = 96;

export const TRACKER_CHUNK_SIZE = 32;

export const TRACKER_SEED_SECONDS = 0.22;

export const MAX_HASH_BATCHES = 2;

export const HASH_BATCH_SIZE = 32;

export const MAX_FETCH_BATCHES = 2;

export const FETCH_BATCH_SIZE = 16;

export const BLOCKED_RENDER_HASH_BATCH_SIZE = 4;

export const BLOCKED_RENDER_FETCH_BATCH_SIZE = 3;

export const MAX_IO_QUEUE = 384;

export const DEFAULT_MAX_TRACKED_CHUNKS = 384;

export const IO_QUEUE_RETENTION_MS = 3000;

export const RECORD_RETENTION_MS = 6000;

export const OUTSIDE_ACTIVE_DROP_MS = 350;

export const LOW_VALUE_ACTIVE_DROP_MS = 3000;

export const LOW_VALUE_ACTIVE_EVICT_LIMIT = 24;

export const LOW_VALUE_ACTIVE_MAX_IMPORTANCE = 0.008;

export const LOW_VALUE_ACTIVE_MAX_GAP = 0.002;

export const MESH_RETRY_COOLDOWN_MS = 180;

export const IO_RENDER_SHARE_TARGET = 0.92;

export const MIN_EXISTING_CHUNKS_BEFORE_BALANCE = 12;

export const RENDER_BACKLOG_IO_PAUSE = 4;

export const MAX_FRAME_CANDIDATES = 56;

export const DEFAULT_FULL_DETAIL_RADIUS_CHUNKS = 8;

export const DEFAULT_NEAR_PRESENCE_RADIUS_CHUNKS = 8;

export const CRITICAL_CENTER_RAY_MAX_CHUNKS = 8;

export const CRITICAL_CENTER_RAY_STEP_CHUNKS = 0.75;

export const MIN_CRITICAL_RAY_HORIZONTAL = 0.08;

export const CRITICAL_SCORE_BOOST = -2400;

export const FULL_DETAIL_SCORE_BOOST = -4800;

export const NEAR_PRESENCE_SCORE_BOOST = -600;

export const MIN_IMPORTANCE_TO_SCHEDULE = 0.006;

export const MIN_GAP_TO_SCHEDULE = 0.012;

export const TOP_MAP_PRECISION = 0.14;

export const EMPTY_PRECISION = 0;

export const ACTIVE_KEEP_EPSILON = 1e-9;

export const DEFAULT_NEAR_IMPORTANCE_HALF_LIFE_RATIO = 1.8;

export const DEFAULT_FAR_IMPORTANCE_HALF_LIFE_RATIO = 0.25;

export const DEFAULT_IMPORTANCE_DECAY_DISTANCE_POWER = 1.75;

export const DEFAULT_DISTANCE_WEIGHT_POWER = 0.65;

export const DEFAULT_DISTANCE_INVERSE_SQUARE_RADIUS_RATIO = 0.35;

export const DEFAULT_NEIGHBOR_PRECISION_EPSILON = 1e-6;

export const DEFAULT_NEIGHBOR_SATISFACTION_PENALTY_BY_COUNT = [
  0, 0, 0.035, 0.075, 0.12, 0.18, 0.25, 0.34, 0.45,
] as const;

export function clampFinite(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

export function normalizeNeighborPenalty(value: readonly number[] | undefined): readonly number[] {
  const source = value?.length === 9 ? value : DEFAULT_NEIGHBOR_SATISFACTION_PENALTY_BY_COUNT;
  const out = new Array<number>(9);
  let previous = 0;

  for (let i = 0; i < out.length; i++) {
    if (i === 0) {
      out[i] = 0;
      continue;
    }
    const raw = source[i];
    const clamped = Number.isFinite(raw)
      ? Math.max(0, Math.min(1, raw))
      : DEFAULT_NEIGHBOR_SATISFACTION_PENALTY_BY_COUNT[i];
    previous = Math.max(previous, clamped);
    out[i] = previous;
  }

  return out;
}

export function activeCellCapacity(radiusChunks: number): number {
  return Math.ceil(Math.PI * (radiusChunks + 1) * (radiusChunks + 1)) + 128;
}

export function heightForSurfaceY(surfaceY: number): number {
  return Math.max(1, Math.min(WORLD_MAX_Y - WORLD_MIN_Y, surfaceY - WORLD_MIN_Y + 1));
}

export function precisionForStep(step: number): number {
  if (!LOD_STEPS.includes(step as LodStep)) throw new RangeError('invalid LOD step');
  if (step === 1) return 1;
  if (step === 2) return 0.58;
  if (step === 4) return 0.34;
  return 0.2;
}

/** Visible geometry can remain on screen while a boundary/content repair is pending. */
export function displayedGeometryPrecision(entry: ChunkSchedulerEntry): number {
  if (entry.displayed === 'full') return 1;
  if (entry.displayed === 'lod') return precisionForStep(entry.displayedLodStep);
  return 0;
}

/** Residency selection distinguishes stale geometry from a valid completed representation. */
export function validGeometryPrecision(entry: ChunkSchedulerEntry): number {
  return entry.dirty ? 0 : displayedGeometryPrecision(entry);
}

export function trackerTimeSeconds(now: number): number {
  if (!Number.isFinite(now)) throw new RangeError('scheduler time must be finite');
  return now / 1000;
}

export function resolveChunkScheduling(scheduling: ChunkSchedulingTuning = {}): ResolvedChunkScheduling {
  const fullDetailRadiusChunks = Math.max(
    1,
    Math.floor(clampFinite(scheduling.fullDetailRadiusChunks, DEFAULT_FULL_DETAIL_RADIUS_CHUNKS, 1, 32)),
  );
  const nearPresenceRadiusChunks = Math.max(
    fullDetailRadiusChunks,
    Math.floor(
      clampFinite(scheduling.nearPresenceRadiusChunks, DEFAULT_NEAR_PRESENCE_RADIUS_CHUNKS, fullDetailRadiusChunks, 32),
    ),
  );
  const activeRadiusChunks = Math.max(
    nearPresenceRadiusChunks,
    clampFinite(
      scheduling.activeRadiusChunks,
      DEFAULT_ACTIVE_RADIUS_CHUNKS,
      MIN_ACTIVE_RADIUS_CHUNKS,
      MAX_ACTIVE_RADIUS_CHUNKS,
    ),
  );
  const maxCandidates = Math.max(
    1,
    Math.floor(
      clampFinite(
        scheduling.maxCandidates,
        activeCellCapacity(activeRadiusChunks),
        1,
        activeCellCapacity(MAX_ACTIVE_RADIUS_CHUNKS),
      ),
    ),
  );
  const maxFrameCandidates = Math.max(
    1,
    Math.floor(
      clampFinite(scheduling.maxFrameCandidates, MAX_FRAME_CANDIDATES, 1, activeCellCapacity(MAX_ACTIVE_RADIUS_CHUNKS)),
    ),
  );
  const maxTrackedChunks = Math.max(
    diskCellCount(nearPresenceRadiusChunks) +
      (nearPresenceRadiusChunks <= CRITICAL_CENTER_RAY_MAX_CHUNKS
        ? Math.ceil(CRITICAL_CENTER_RAY_MAX_CHUNKS / CRITICAL_CENTER_RAY_STEP_CHUNKS)
        : 0),
    64,
    Math.floor(clampFinite(scheduling.maxTrackedChunks, DEFAULT_MAX_TRACKED_CHUNKS, 64, 4096)),
  );
  const tauImportance = clampFinite(scheduling.tauImportance, 0.85, 0.05, 10);
  const baseImportanceHalfLife = tauImportance * Math.LN2;
  const nearImportanceHalfLife = clampFinite(
    scheduling.nearImportanceHalfLife,
    baseImportanceHalfLife * DEFAULT_NEAR_IMPORTANCE_HALF_LIFE_RATIO,
    0.05,
    30,
  );
  const farImportanceHalfLife = Math.min(
    nearImportanceHalfLife,
    clampFinite(
      scheduling.farImportanceHalfLife,
      baseImportanceHalfLife * DEFAULT_FAR_IMPORTANCE_HALF_LIFE_RATIO,
      0.02,
      30,
    ),
  );
  const distanceInverseSquareRadiusBlocks =
    scheduling.distanceInverseSquareRadiusChunks === null
      ? null
      : clampFinite(
          scheduling.distanceInverseSquareRadiusChunks,
          activeRadiusChunks * DEFAULT_DISTANCE_INVERSE_SQUARE_RADIUS_RATIO,
          2,
          activeRadiusChunks,
        ) * CHUNK_SIZE_BLOCKS;

  const neighborSatisfactionPenaltyByCount = normalizeNeighborPenalty(scheduling.neighborSatisfactionPenaltyByCount);
  const minSatisfaction = clampFinite(
    scheduling.minSatisfaction,
    -neighborSatisfactionPenaltyByCount[neighborSatisfactionPenaltyByCount.length - 1],
    -1,
    0,
  );

  return {
    activeRadiusChunks,
    activeRadiusBlocks: activeRadiusChunks * CHUNK_SIZE_BLOCKS,
    maxCandidates,
    maxFrameCandidates,
    maxTrackedChunks,
    fullDetailRadiusChunks,
    nearPresenceRadiusChunks,
    tauImportance,
    nearImportanceHalfLife,
    farImportanceHalfLife,
    importanceDecayDistancePower: clampFinite(
      scheduling.importanceDecayDistancePower,
      DEFAULT_IMPORTANCE_DECAY_DISTANCE_POWER,
      0.1,
      8,
    ),
    tauSatisfaction: clampFinite(scheduling.tauSatisfaction, 3.0, 0.05, 30),
    angleSigmaRad: clampFinite(scheduling.angleSigmaRad, 0.75, 0.05, Math.PI),
    fovRadiusRad:
      scheduling.fovRadiusRad == null || !Number.isFinite(scheduling.fovRadiusRad)
        ? null
        : clampFinite(scheduling.fovRadiusRad, Math.PI, 0.05, Math.PI),
    distanceWeightPower: clampFinite(scheduling.distanceWeightPower, DEFAULT_DISTANCE_WEIGHT_POWER, 0.1, 6),
    distanceInverseSquareRadiusBlocks,
    overshootEta: clampFinite(scheduling.overshootEta, 0.18, 0, 2),
    neighborPrecisionEpsilon: clampFinite(
      scheduling.neighborPrecisionEpsilon,
      DEFAULT_NEIGHBOR_PRECISION_EPSILON,
      0,
      0.1,
    ),
    neighborSatisfactionPenaltyByCount,
    minSatisfaction,
    minImportanceToSchedule: clampFinite(scheduling.minImportanceToSchedule, MIN_IMPORTANCE_TO_SCHEDULE, 0, 1),
    minGapToSchedule: clampFinite(scheduling.minGapToSchedule, MIN_GAP_TO_SCHEDULE, -1, 1),
  };
}

export function targetLodStep(importance: number, previous: LodStep, disableLod: boolean): LodStep {
  if (disableLod) return 1;
  // Satisfaction is the precision already on screen, not fresh demand. Using
  // it here made every completed full mesh permanently target step 1.
  // Gap ranks pending work, but changes as our own/neighbors' meshes arrive.
  // It must not feed back into demanded detail. Separate upgrade/downgrade
  // thresholds keep attention near a boundary from flipping LOD repeatedly.
  const thresholds = [
    [1, 0.72],
    [2, 0.44],
    [4, 0.24],
  ] as const;
  for (const [step, threshold] of thresholds) if (importance >= threshold * (previous <= step ? 0.9 : 1)) return step;
  return 8;
}

export function meshCoversTarget(entry: ChunkSchedulerEntry, targetStep: LodStep): boolean {
  if (entry.displayed === 'none') return false;
  if (targetStep === 1) return entry.displayed === 'full';
  if (entry.displayed === 'full') return true;
  return entry.displayed === 'lod' && entry.displayedLodStep > 0 && entry.displayedLodStep <= targetStep;
}

export function meshSatisfiesTarget(entry: ChunkSchedulerEntry, targetStep: LodStep, disableLod: boolean): boolean {
  return !entry.dirty && meshCoversTarget(entry, targetStep) && !needsFullDowngrade(entry, targetStep, disableLod);
}

export function needsFullDowngrade(entry: ChunkSchedulerEntry, targetStep: LodStep, disableLod: boolean): boolean {
  return !disableLod && targetStep > 1 && entry.displayed === 'full' && !entry.dirty;
}

export function comparePriority(a: ChunkPriority, b: ChunkPriority): number {
  return a.tier - b.tier || a.score - b.score || b.updatedAt - a.updatedAt;
}

export function compareMeshTaskPriority(a: MeshTask, b: MeshTask): number {
  return comparePriority(a, b) || a.step - b.step;
}

const diskCounts = new Map<number, number>();

/** Exact capacity of a direction-independent chunk disk, including the center. */
export function diskCellCount(radius: number): number {
  if (!Number.isSafeInteger(radius) || radius < 0 || radius > MAX_ACTIVE_RADIUS_CHUNKS)
    throw new RangeError('invalid chunk disk radius');
  const cached = diskCounts.get(radius);
  if (cached !== undefined) return cached;
  let count = 0;
  for (let x = -radius; x <= radius; x++)
    for (let z = -radius; z <= radius; z++) if (x * x + z * z <= radius * radius) count++;
  diskCounts.set(radius, count);
  return count;
}

/** Queue dispatch and result acceptance use exactly the same quality predicate. */
export function meshMatchesTarget(kind: 'full' | 'lod', step: LodStep, target: LodStep, disableLod: boolean): boolean {
  return kind === 'full' ? step === 1 && target === 1 : !disableLod && target !== 1 && step > 1 && step <= target;
}

export function isDemandFresh(record: Readonly<ChunkDemand> | undefined, now: number): boolean {
  return !!record && now - record.wantedAt <= IO_QUEUE_RETENTION_MS;
}

export function chunkRetryDelayMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new RangeError('retry attempt must be positive');
  return Math.min(30000, 250 * 2 ** Math.min(7, attempt - 1));
}
