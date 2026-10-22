import type { ViewState } from '../view/state';

import type { LodStep, MeshTaskKind } from '../view/terrain';

export type ChunkState = 'checking' | 'resolving' | 'hashed' | 'fetching' | 'decoding' | 'stored' | 'absent' | 'error';

export interface ChunkSchedulingTuning {
  /** Camera-grid active radius in chunks. This is independent from fog/view-distance UI settings. */
  activeRadiusChunks?: number;
  /** Upper bound for cells ranked and kept by the tracker. Defaults to the full active disk. */
  maxCandidates?: number;
  /** Maximum scheduler candidates materialized from the current tracker ranking each frame. */
  maxFrameCandidates?: number;
  /** Maximum tracked chunk entries retained after eviction. */
  maxTrackedChunks?: number;
  /** Full-model radius promised by view distance; completion state cannot reduce it. */
  fullDetailRadiusChunks?: number;
  /** Direction-independent disk that guarantees at least the current target LOD. */
  nearPresenceRadiusChunks?: number;
  /** Time constant, in seconds, for camera attention to react and decay. */
  tauImportance?: number;
  /** Importance half-life, in seconds, for cells near the camera. */
  nearImportanceHalfLife?: number;
  /** Importance half-life, in seconds, for cells near the active-radius edge. */
  farImportanceHalfLife?: number;
  /** Shapes the near-to-far importance half-life interpolation. */
  importanceDecayDistancePower?: number;
  /** Time constant, in seconds, for satisfaction overshoot to decay. */
  tauSatisfaction?: number;
  /** Gaussian gaze falloff sigma in radians. */
  angleSigmaRad?: number;
  /** Optional hard gaze cutoff in radians. null disables the cutoff. */
  fovRadiusRad?: number | null;
  /** Horizontal distance falloff exponent. */
  distanceWeightPower?: number;
  /** Soft inverse-square distance scale in chunks. null disables this multiplier. */
  distanceInverseSquareRadiusChunks?: number | null;
  /** Temporary satisfaction overshoot when precision improves. */
  overshootEta?: number;
  /** Precision delta required for a neighbor to count as higher precision. */
  neighborPrecisionEpsilon?: number;
  /** Satisfaction penalty for 0..8 higher-precision neighbors. */
  neighborSatisfactionPenaltyByCount?: readonly number[];
  /** Satisfaction clamp lower bound. Negative values let neighbor penalties create positive gaps. */
  minSatisfaction?: number;
  /** Minimum importance needed before a not-yet-satisfied cell schedules work. */
  minImportanceToSchedule?: number;
  /** Minimum importance-satisfaction gap needed before a not-yet-satisfied cell schedules work. */
  minGapToSchedule?: number;
}

export interface ChunkSchedulerOptions {
  /** When true, the scheduler never emits LOD mesh tasks and only targets full meshes. */
  disableLod?: boolean;
  scheduling?: ChunkSchedulingTuning;
}

export interface SchedulerCellInfo {
  topMapSurfaceY: number | null;
  hasChunkSource: boolean | null;
}

export interface ChunkPriority {
  tier: number;
  score: number;
  updatedAt: number;
}

export interface MeshTask extends ChunkPriority {
  key: string;
  kind: MeshTaskKind;
  step: LodStep;
}

export interface ChunkCandidate extends ChunkPriority {
  key: string;
  cx: number;
  cz: number;
  targetStep: LodStep;
  importance: number;
  satisfaction: number;
  gap: number;
}

export interface CriticalCell {
  i: number;
  j: number;
}

export interface ChunkSchedulerEntry {
  key: string;
  cx: number;
  cz: number;
  retryAt?: number;
  surfaceY?: number;
  state: ChunkState;
  pendingFull: boolean;
  pendingLod: boolean;
  pendingLodStep: number;
  displayed: 'none' | 'full' | 'lod';
  displayedLodStep: number;
  displayedVersion: number;
  dirty: boolean;
}

export interface ChunkDemand {
  readonly key: string;
  readonly cx: number;
  readonly cz: number;
  readonly wantedAt: number;
  readonly targetStep: LodStep;
  readonly importance: number;
  readonly satisfaction: number;
  readonly gap: number;
  readonly priority: Readonly<ChunkPriority>;
  readonly boost: Readonly<ChunkPriority & { reason: 'dependency' | 'repair' }> | null;
  readonly meshRetryAt: number;
}

export interface SchedulerQueueStats {
  hashQueued: number;
  fetchQueued: number;
  meshQueued: number;
  trackedPriorities: number;
}

export interface SchedulerFramePlan {
  demands: ChunkCandidate[];
  candidates: ChunkCandidate[];
  keepKeys: Set<string>;
  protectedKeys: Set<string>;
  fullDetailKeys: ReadonlySet<string>;
  centerCx: number;
  centerCz: number;
}

export type SchedulerAction =
  | { type: 'wantChunk'; key: string; cx: number; cz: number }
  | { type: 'dropChunk'; key: string };

export interface SchedulerTickInput {
  view: ViewState;
  now: number;
  options: ChunkSchedulerOptions;
  keyFor: (cx: number, cz: number) => string;
  cellInfoFor?: (cx: number, cz: number) => SchedulerCellInfo | null;
  entries: ReadonlyMap<string, ChunkSchedulerEntry>;
}

export interface SchedulerViewInput extends SchedulerTickInput {
  demands: ReadonlyMap<string, Readonly<ChunkDemand>>;
}

export interface SchedulerTickResult {
  actions: SchedulerAction[];
  fullDetailKeys: ReadonlySet<string>;
  keepKeys: Set<string>;
  centerCx: number;
  centerCz: number;
  candidateCount: number;
  evictedCount: number;
}

export interface SchedulerWorkInput {
  now: number;
  activeHashBatches: number;
  activeFetchBatches: number;
  activeMeshTasks: number;
  maxMeshTasks: number;
  entries: ReadonlyMap<string, ChunkSchedulerEntry>;
  includeHash?: boolean;
  includeFetch?: boolean;
  includeMesh?: boolean;
}

export interface SchedulerWorkBatch {
  hashBatches: string[][];
  fetchBatches: string[][];
  meshTasks: MeshTask[];
  hashWakeAt: number | null;
  fetchWakeAt: number | null;
}

export type SchedulerEvent =
  | { type: 'hashNeeded'; key: string }
  | { type: 'fetchNeeded'; key: string }
  | { type: 'dependencyNeeded'; centerKey: string; key: string; now: number }
  | { type: 'meshDeferred'; key: string; now: number }
  | { type: 'meshInvalidated'; entry: ChunkSchedulerEntry; now: number }
  | { type: 'chunkStored'; entry: ChunkSchedulerEntry; now: number }
  | {
      type: 'meshDisplayed';
      entry: ChunkSchedulerEntry;
      kind: MeshTaskKind;
      step: LodStep;
      version: number;
      now: number;
    }
  | { type: 'chunkDropped'; key: string };

export interface ReadyMeshTask {
  entry: ChunkSchedulerEntry;
  kind: MeshTaskKind;
  step: LodStep;
  version: number;
}

export interface WorkerDispatchInput {
  now: number;
  activeTasks: number;
  maxTasks: number;
  workerLoads: readonly number[];
  ready: readonly ReadyMeshTask[];
  entries: ReadonlyMap<string, ChunkSchedulerEntry>;
}

export interface WorkerDispatchPlan {
  start: { task: ReadyMeshTask; workerIndex: number }[];
  discard: number[];
}

export interface SchedulerMeshResult {
  entry: ChunkSchedulerEntry;
  kind: MeshTaskKind;
  step: LodStep;
  version: number;
  now: number;
}

export interface SchedulerCellDiagnostic {
  cx: number;
  cz: number;
  height: number;
  precision: number;
  importance: number;
  satisfaction: number;
  gap: number;
  bump: number;
}

export interface ChunkSchedulerDiagnosticSnapshot {
  capturedAt: number;
  center: { cx: number; cz: number };
  activeRadiusChunks: number;
  maxCandidates: number;
  trackedChunkLimit: number;
  lodDisabled: boolean;
  fullDetailRadiusChunks: number;
  nearPresenceRadiusChunks: number;
  queues: {
    hash: string[];
    fetch: string[];
    mesh: MeshTask[];
  };
  trackedPriorities: number;
}

export interface ResolvedChunkScheduling {
  activeRadiusChunks: number;
  activeRadiusBlocks: number;
  maxCandidates: number;
  maxFrameCandidates: number;
  maxTrackedChunks: number;
  fullDetailRadiusChunks: number;
  nearPresenceRadiusChunks: number;
  tauImportance: number;
  nearImportanceHalfLife: number;
  farImportanceHalfLife: number;
  importanceDecayDistancePower: number;
  tauSatisfaction: number;
  angleSigmaRad: number;
  fovRadiusRad: number | null;
  distanceWeightPower: number;
  distanceInverseSquareRadiusBlocks: number | null;
  overshootEta: number;
  neighborPrecisionEpsilon: number;
  neighborSatisfactionPenaltyByCount: readonly number[];
  minSatisfaction: number;
  minImportanceToSchedule: number;
  minGapToSchedule: number;
}
