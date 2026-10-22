import type * as THREE from 'three';

export const LOD_STEPS = [1, 2, 4, 8] as const;

export type ChunkState = 'checking' | 'resolving' | 'hashed' | 'fetching' | 'decoding' | 'stored' | 'absent' | 'error';

export type LodStep = (typeof LOD_STEPS)[number];

export type MeshTaskKind = 'full' | 'lod';

export type ChunkSchedulerCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

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

export interface ChunkSchedulerEntry extends SchedulerEntryUpdate {
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

export interface SchedulerFramePlan {
  candidates: ChunkCandidate[];
  keepKeys: Set<string>;
  protectedKeys: Set<string>;
  centerCx: number;
  centerCz: number;
}

export interface SchedulerEntryUpdate {
  key: string;
  cx: number;
  cz: number;
  lastWantedAt: number;
  lastTier: number;
  lastScore: number;
  lastTargetStep: LodStep;
  lastForcedFull: boolean;
  lastImportance: number;
  lastSatisfaction: number;
  lastGap: number;
}

export type SchedulerAction =
  | { type: 'wantChunk'; key: string; cx: number; cz: number }
  | { type: 'dropChunk'; key: string };

export interface SchedulerTickInput {
  camera: ChunkSchedulerCamera;
  now: number;
  topDownView?: boolean;
  options: ChunkSchedulerOptions;
  keyFor: (cx: number, cz: number) => string;
  cellInfoFor?: (cx: number, cz: number) => SchedulerCellInfo | null;
  entries: ReadonlyMap<string, ChunkSchedulerEntry>;
}

export interface SchedulerTickResult {
  actions: SchedulerAction[];
  entryUpdates: SchedulerEntryUpdate[];
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
  | { type: 'hashNeeded'; key: string; priority?: ChunkPriority }
  | { type: 'fetchNeeded'; key: string; priority?: ChunkPriority }
  | { type: 'meshDeferred'; key: string; kind: MeshTaskKind; step: LodStep; fallbackTier: number; now: number }
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

export interface SchedulerMeshResult {
  entry: ChunkSchedulerEntry;
  kind: MeshTaskKind;
  step: LodStep;
  version: number;
  now: number;
}

export interface ChunkRenderStats {
  trackedChunks: number;
  nbt: number;
  lodReady: number;
  lodRendered: number;
  fullReady: number;
  fullRendered: number;
}

export interface ChunkProfileStats {
  workerCount: number;
  activeMeshTasks: number;
  workerChunkCopies: number;
  estimatedWorkerBytes: number;
  cacheLookups: number;
  errorChunks: number;
  retryingChunks: number;
  displayedMeshBytes: number;
  chunkBytesDecoded: number;
  diagnostics: ChunkDiagnosticEvent[];
  hashFetchMsAvg: number;
  chunkFetchMsAvg: number;
  parseMsAvg: number;
  fullMeshMsAvg: number;
  lodMeshMsAvg: number;
  fullCacheHits: number;
  fullCacheMisses: number;
  lodCacheHits: number;
  lodCacheMisses: number;
}

export type ChunkDiagnosticOp = 'hashFetch' | 'chunkFetch' | 'parse' | 'fullMesh' | 'lodMesh';

export type ChunkDiagnosticKind = 'slow' | 'delayed';

export interface ChunkDiagnosticEvent {
  id: number;
  time: number;
  kind: ChunkDiagnosticKind;
  op: ChunkDiagnosticOp;
  detail: string;
  durationMs: number;
  thresholdMs: number;
  sampleCount: number;
}

export interface ChunkSchedulerStats extends ChunkRenderStats, ChunkProfileStats {
  hashQueued: number;
  fetchQueued: number;
  meshQueued: number;
  trackedPriorities: number;
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

const EMPTY_RENDER_STATS: ChunkRenderStats = {
  trackedChunks: 0,
  nbt: 0,
  lodReady: 0,
  lodRendered: 0,
  fullReady: 0,
  fullRendered: 0,
};

const EMPTY_PROFILE_STATS: ChunkProfileStats = {
  workerCount: 0,
  activeMeshTasks: 0,
  workerChunkCopies: 0,
  estimatedWorkerBytes: 0,
  cacheLookups: 0,
  errorChunks: 0,
  retryingChunks: 0,
  displayedMeshBytes: 0,
  chunkBytesDecoded: 0,
  diagnostics: [],
  hashFetchMsAvg: 0,
  chunkFetchMsAvg: 0,
  parseMsAvg: 0,
  fullMeshMsAvg: 0,
  lodMeshMsAvg: 0,
  fullCacheHits: 0,
  fullCacheMisses: 0,
  lodCacheHits: 0,
  lodCacheMisses: 0,
};

export const EMPTY_CHUNK_SCHEDULER_STATS: ChunkSchedulerStats = {
  ...EMPTY_RENDER_STATS,
  ...EMPTY_PROFILE_STATS,
  hashQueued: 0,
  fetchQueued: 0,
  meshQueued: 0,
  trackedPriorities: 0,
};
