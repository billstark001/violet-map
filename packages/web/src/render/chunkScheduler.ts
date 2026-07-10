import * as THREE from 'three';
import { CameraGridTracker, type Pose, type RankedCell, type RankingResult } from '@violet-map/core';
import { debugLog, isDebugLoggingEnabled } from '../logger';

export type ChunkState = 'checking' | 'hashed' | 'fetching' | 'decoding' | 'stored' | 'absent' | 'error';

const CHUNK_SIZE_BLOCKS = 16;
const CHUNK_WORLD_MIN_Y = -80;
const CHUNK_WORLD_MAX_Y = 384;
const DEFAULT_SURFACE_Y = 64;

const DEFAULT_ACTIVE_RADIUS_CHUNKS = 32;
const MIN_ACTIVE_RADIUS_CHUNKS = 8;
const MAX_ACTIVE_RADIUS_CHUNKS = 96;
const TRACKER_CHUNK_SIZE = 32;
const TRACKER_SEED_SECONDS = 0.22;
const TRACKER_RESET_RADIUS_DELTA_CHUNKS = 2;

const MAX_HASH_BATCHES = 2;
const HASH_BATCH_SIZE = 32;
const MAX_FETCH_BATCHES = 2;
const FETCH_BATCH_SIZE = 16;
const BLOCKED_RENDER_HASH_BATCH_SIZE = 4;
const BLOCKED_RENDER_FETCH_BATCH_SIZE = 3;
const MAX_IO_QUEUE = 384;
const MAX_MESH_QUEUE = 64;
const MAX_TRACKED_CHUNKS = 384;

const IO_QUEUE_RETENTION_MS = 3000;
const RECORD_RETENTION_MS = 6000;
const OUTSIDE_ACTIVE_DROP_MS = 350;
const LOW_VALUE_ACTIVE_DROP_MS = 3000;
const LOW_VALUE_ACTIVE_EVICT_LIMIT = 24;
const LOW_VALUE_ACTIVE_MAX_IMPORTANCE = 0.008;
const LOW_VALUE_ACTIVE_MAX_GAP = 0.002;
const LOW_VALUE_ACTIVE_MIN_DISTANCE_CHUNKS = 3;
const MESH_RETRY_COOLDOWN_MS = 180;
const IO_RENDER_SHARE_TARGET = 0.92;
const MIN_EXISTING_CHUNKS_BEFORE_BALANCE = 12;
const RENDER_BACKLOG_IO_PAUSE = 4;
const MAX_FRAME_CANDIDATES = 56;
// Keep a view-direction-independent inner disk ready. This prevents nearby
// holes from waiting until the player turns toward them.
const CRITICAL_NEAR_RADIUS_CHUNKS = 4;
const NEAR_PRESENCE_RADIUS_CHUNKS = 8;
const CRITICAL_CENTER_RAY_MAX_CHUNKS = 8;
const CRITICAL_CENTER_RAY_STEP_CHUNKS = 0.75;
const MIN_CRITICAL_RAY_HORIZONTAL = 0.08;
const CRITICAL_SCORE_BOOST = -2400;
const CRITICAL_NEAR_SCORE_BOOST = -4800;
const NEAR_PRESENCE_SCORE_BOOST = -600;

const MIN_IMPORTANCE_TO_SCHEDULE = 0.006;
const MIN_GAP_TO_SCHEDULE = 0.012;
const TOP_MAP_PRECISION = 0.14;
const EMPTY_PRECISION = 0;
const ACTIVE_KEEP_EPSILON = 1e-9;
const DEFAULT_NEAR_IMPORTANCE_HALF_LIFE_RATIO = 1.8;
const DEFAULT_FAR_IMPORTANCE_HALF_LIFE_RATIO = 0.25;
const DEFAULT_IMPORTANCE_DECAY_DISTANCE_POWER = 1.75;
const DEFAULT_DISTANCE_WEIGHT_POWER = 0.65;
const DEFAULT_DISTANCE_INVERSE_SQUARE_RADIUS_RATIO = 0.35;
const DEFAULT_NEIGHBOR_PRECISION_EPSILON = 1e-6;
const DEFAULT_NEIGHBOR_SATISFACTION_PENALTY_BY_COUNT = [
  0,
  0,
  0.035,
  0.075,
  0.12,
  0.18,
  0.25,
  0.34,
  0.45,
] as const;

export const LOD_STEPS = [1, 2, 4, 8] as const;
export type LodStep = typeof LOD_STEPS[number];
export type MeshTaskKind = 'full' | 'lod';
export type ChunkSchedulerCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

export interface ChunkSchedulingTuning {
  /** Camera-grid active radius in chunks. This is independent from fog/view-distance UI settings. */
  activeRadiusChunks?: number;
  /** Upper bound for cells ranked and kept by the tracker. Defaults to the full active disk. */
  maxCandidates?: number;
  /** Maximum scheduler candidates materialized from the current tracker ranking each frame. */
  maxFrameCandidates?: number;
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

interface ChunkCandidate extends ChunkPriority {
  key: string;
  cx: number;
  cz: number;
  targetStep: LodStep;
  importance: number;
  satisfaction: number;
  gap: number;
}

interface CriticalCell {
  i: number;
  j: number;
}

export interface ChunkSchedulerEntry {
  key: string;
  cx: number;
  cz: number;
  state: ChunkState;
  pendingFull: boolean;
  pendingLod: boolean;
  pendingLodStep: number;
  displayed: 'none' | 'full' | 'lod';
  displayedLodStep: number;
  displayedVersion: number;
  dirty: boolean;
  lastWantedAt: number;
  lastTier: number;
  lastScore: number;
  lastTargetStep: LodStep;
  lastForcedFull: boolean;
  lastImportance: number;
  lastSatisfaction: number;
  lastGap: number;
}

interface SchedulerRecord {
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

interface SchedulerFramePlan {
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
  | { type: 'removeMesh'; key: string }
  | { type: 'dropChunk'; key: string };

export interface SchedulerTickInput {
  camera: ChunkSchedulerCamera;
  now: number;
  force: boolean;
  topDownView?: boolean;
  options: ChunkSchedulerOptions;
  keyFor: (cx: number, cz: number) => string;
  entryFor: (key: string) => ChunkSchedulerEntry | null;
  cellInfoFor?: (cx: number, cz: number) => SchedulerCellInfo | null;
  entries: Iterable<ChunkSchedulerEntry>;
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
  entries: Iterable<ChunkSchedulerEntry>;
  entryFor: (key: string) => ChunkSchedulerEntry | null;
  includeHash?: boolean;
  includeFetch?: boolean;
  includeMesh?: boolean;
}

export interface SchedulerWorkBatch {
  hashBatches: string[][];
  fetchBatches: string[][];
  meshTasks: MeshTask[];
  hasHashWork: boolean;
  hasFetchWork: boolean;
}

export type SchedulerEvent =
  | { type: 'hashNeeded'; key: string; priority?: ChunkPriority }
  | { type: 'fetchNeeded'; key: string; priority?: ChunkPriority }
  | { type: 'meshDeferred'; key: string; kind: MeshTaskKind; step: LodStep; fallbackTier: number; now: number }
  | { type: 'meshInvalidated'; entry: ChunkSchedulerEntry; now: number }
  | { type: 'chunkStored'; entry: ChunkSchedulerEntry; now: number }
  | { type: 'meshDisplayed'; entry: ChunkSchedulerEntry; kind: MeshTaskKind; step: LodStep; version: number; now: number }
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
  displayedMeshBytes: number;
  chunkBytesFetched: number;
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
  criticalNearRadiusChunks: number;
  nearPresenceRadiusChunks: number;
  queues: {
    hash: string[];
    fetch: string[];
    mesh: MeshTask[];
  };
  trackedPriorities: number;
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
  displayedMeshBytes: 0,
  chunkBytesFetched: 0,
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

interface TrackerRuntimeConfig {
  activeRadiusChunks: number;
  activeRadiusBlocks: number;
  maxCandidates: number;
  maxFrameCandidates: number;
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

function clampFinite(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function normalizeNeighborPenalty(value: readonly number[] | undefined): readonly number[] {
  const source = value?.length === 9 ? value : DEFAULT_NEIGHBOR_SATISFACTION_PENALTY_BY_COUNT;
  const out = new Array<number>(9);
  let previous = 0;

  for (let i = 0; i < out.length; i++) {
    if (i === 0) {
      out[i] = 0;
      continue;
    }
    const raw = source[i];
    const clamped = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : DEFAULT_NEIGHBOR_SATISFACTION_PENALTY_BY_COUNT[i];
    previous = Math.max(previous, clamped);
    out[i] = previous;
  }

  return out;
}

function activeCellCapacity(radiusChunks: number): number {
  return Math.ceil(Math.PI * (radiusChunks + 1) * (radiusChunks + 1)) + 128;
}

function heightForSurfaceY(surfaceY: number): number {
  return Math.max(1, Math.min(CHUNK_WORLD_MAX_Y - CHUNK_WORLD_MIN_Y, surfaceY - CHUNK_WORLD_MIN_Y + 1));
}

function normalizeLodStep(value: number, fallback: LodStep): LodStep {
  return LOD_STEPS.includes(value as LodStep) ? value as LodStep : fallback;
}

function precisionForStep(step: number): number {
  const normalized = normalizeLodStep(step, 8);
  if (normalized === 1) return 1;
  if (normalized === 2) return 0.58;
  if (normalized === 4) return 0.34;
  return 0.2;
}

function stepForPrecisionTarget(precision: number): LodStep {
  if (precision >= 0.72) return 1;
  if (precision >= 0.44) return 2;
  if (precision >= 0.24) return 4;
  return 8;
}

function normalizeTimeMs(now: number): number {
  return Number.isFinite(now) ? now : performance.now();
}

function trackerTimeSeconds(now: number): number {
  return normalizeTimeMs(now) / 1000;
}

function priorityKey(task: Pick<MeshTask, 'key' | 'kind'>): string {
  return `${task.key}\u0000${task.kind}`;
}

function emptyRankingResult(time: number): RankingResult {
  return {
    time,
    activeCount: 0,
    importance: { top: [], bottom: [] },
    satisfaction: { top: [], bottom: [] },
    gap: { top: [], bottom: [] },
  };
}

function trackerConfigKey(cfg: TrackerRuntimeConfig): string {
  return [
    cfg.activeRadiusChunks,
    cfg.maxCandidates,
    cfg.tauImportance,
    cfg.nearImportanceHalfLife,
    cfg.farImportanceHalfLife,
    cfg.importanceDecayDistancePower,
    cfg.tauSatisfaction,
    cfg.angleSigmaRad,
    cfg.fovRadiusRad ?? 'none',
    cfg.distanceWeightPower,
    cfg.distanceInverseSquareRadiusBlocks ?? 'none',
    cfg.overshootEta,
    cfg.neighborPrecisionEpsilon,
    cfg.neighborSatisfactionPenaltyByCount.join(','),
    cfg.minSatisfaction,
  ].join('|');
}

export class ChunkScheduler {
  private tracker: CameraGridTracker | null = null;
  private trackerKey = '';
  private trackerSeeded = false;

  private hashQueue = new Set<string>();
  private fetchQueue = new Set<string>();
  private meshQueue = new Map<string, MeshTask>();
  private meshCooldownUntil = new Map<string, number>();
  private priorityByKey = new Map<string, ChunkPriority>();
  private recordByKey = new Map<string, SchedulerRecord>();
  private renderStats: ChunkRenderStats = { ...EMPTY_RENDER_STATS };
  private profileStats: ChunkProfileStats = { ...EMPTY_PROFILE_STATS };

  private lastCenterCx = 0;
  private lastCenterCz = 0;
  private lastActiveRadiusChunks = DEFAULT_ACTIVE_RADIUS_CHUNKS;
  private lastMaxCandidates = activeCellCapacity(DEFAULT_ACTIVE_RADIUS_CHUNKS);
  private tmpDirection = new THREE.Vector3();

  constructor(private opts: ChunkSchedulerOptions = {}) { }

  syncStats(stats: ChunkRenderStats, profileStats: ChunkProfileStats = EMPTY_PROFILE_STATS): ChunkSchedulerStats {
    this.renderStats = { ...stats };
    this.profileStats = { ...profileStats };
    return this.stats();
  }

  stats(): ChunkSchedulerStats {
    return {
      ...this.renderStats,
      ...this.profileStats,
      hashQueued: this.hashQueue.size,
      fetchQueued: this.fetchQueue.size,
      meshQueued: this.meshQueue.size,
      trackedPriorities: this.recordByKey.size,
    };
  }

  /**
   * Returns the most recently integrated tracker state for a resident column.
   * It deliberately does not advance camera time, so exporting diagnostics
   * cannot alter the scheduler's next camera integration interval.
   */
  diagnosticCell(cx: number, cz: number): SchedulerCellDiagnostic | null {
    const tracker = this.tracker;
    if (!tracker) return null;
    // Do not advance the tracker here: diagnostics must not change the camera
    // integration interval that the next scheduler tick will consume.
    const snapshot = tracker.getCellSnapshot(cx, cz, tracker.currentTime);
    return {
      cx,
      cz,
      height: snapshot.height,
      precision: snapshot.precision,
      importance: snapshot.importance,
      satisfaction: snapshot.satisfaction,
      gap: snapshot.importance - snapshot.satisfaction,
      bump: snapshot.bump,
    };
  }

  diagnosticSnapshot(now: number): ChunkSchedulerDiagnosticSnapshot {
    return {
      capturedAt: now,
      center: { cx: this.lastCenterCx, cz: this.lastCenterCz },
      activeRadiusChunks: this.lastActiveRadiusChunks,
      maxCandidates: this.lastMaxCandidates,
      trackedChunkLimit: MAX_TRACKED_CHUNKS,
      lodDisabled: this.lodDisabled(),
      criticalNearRadiusChunks: CRITICAL_NEAR_RADIUS_CHUNKS,
      nearPresenceRadiusChunks: NEAR_PRESENCE_RADIUS_CHUNKS,
      queues: {
        hash: [...this.hashQueue].sort((a, b) => this.compareQueuedKeys(a, b)),
        fetch: [...this.fetchQueue].sort((a, b) => this.compareQueuedKeys(a, b)),
        mesh: [...this.meshQueue.values()].sort((a, b) => this.compareMeshTaskPriority(a, b)),
      },
      trackedPriorities: this.recordByKey.size,
    };
  }

  clear() {
    this.hashQueue.clear();
    this.fetchQueue.clear();
    this.meshQueue.clear();
    this.meshCooldownUntil.clear();
    this.priorityByKey.clear();
    this.recordByKey.clear();
    this.resetTracker();
  }

  tick(input: SchedulerTickInput): SchedulerTickResult {
    this.opts = input.options;
    const frame = this.planFrame(input);
    this.lastCenterCx = frame.centerCx;
    this.lastCenterCz = frame.centerCz;

    const actions: SchedulerAction[] = [];
    const entryUpdates: SchedulerEntryUpdate[] = [];

    for (const candidate of frame.candidates) {
      const entry = input.entryFor(candidate.key);
      const update = this.rememberRecord(candidate);
      this.rememberPriority(candidate.key, candidate);
      entryUpdates.push(update);

      if (!entry) {
        this.enqueueHash(candidate.key);
        actions.push({ type: 'wantChunk', key: candidate.key, cx: candidate.cx, cz: candidate.cz });
        continue;
      }

      const decision = this.scheduleCandidate(candidate, entry);
      if (decision.removeMesh) actions.push({ type: 'removeMesh', key: candidate.key });
    }

    this.pruneQueues(input.now, input.entryFor);
    this.expirePriorities(input.now);

    const newCandidateCount = frame.candidates.reduce(
      (count, candidate) => count + (input.entryFor(candidate.key) ? 0 : 1),
      0,
    );
    const evictedKeys = this.evictKeys(frame.keepKeys, frame.protectedKeys, input.entries, input.now, newCandidateCount);
    for (const key of evictedKeys) actions.push({ type: 'dropChunk', key });

    return {
      actions,
      entryUpdates,
      keepKeys: frame.keepKeys,
      centerCx: frame.centerCx,
      centerCz: frame.centerCz,
      candidateCount: frame.candidates.length,
      evictedCount: evictedKeys.length,
    };
  }

  nextWork(input: SchedulerWorkInput): SchedulerWorkBatch {
    const includeHash = input.includeHash ?? true;
    const includeFetch = input.includeFetch ?? true;
    const includeMesh = input.includeMesh ?? true;
    const hashBatches: string[][] = [];
    const fetchBatches: string[][] = [];
    const meshTasks: MeshTask[] = [];

    if (includeHash) {
      const batch = this.nextHashBatch(input);
      if (batch.length) hashBatches.push(batch);
    }

    if (includeFetch) {
      const batch = this.nextFetchBatch(input);
      if (batch.length) fetchBatches.push(batch);
    }

    if (includeMesh) {
      const selectedMeshKeys = new Set<string>();
      while (input.activeMeshTasks + meshTasks.length < input.maxMeshTasks) {
        const task = this.nextMeshTask(input.entryFor, input.entries, input.now, selectedMeshKeys);
        if (!task) break;
        selectedMeshKeys.add(task.key);
        meshTasks.push(task);
      }
    }

    return {
      hashBatches,
      fetchBatches,
      meshTasks,
      hasHashWork: this.hashQueue.size > 0,
      hasFetchWork: this.fetchQueue.size > 0,
    };
  }

  notify(event: SchedulerEvent): void {
    switch (event.type) {
      case 'hashNeeded':
        if (event.priority) this.rememberPriority(event.key, event.priority);
        this.enqueueHash(event.key);
        return;
      case 'fetchNeeded':
        if (event.priority) this.rememberPriority(event.key, event.priority);
        this.enqueueFetch(event.key);
        return;
      case 'meshDeferred': {
        const priority = this.priorityByKey.get(event.key) ?? {
          tier: event.fallbackTier,
          score: 0,
          updatedAt: event.now,
        };
        this.enqueueMeshTask({ key: event.key, kind: event.kind, step: event.step, ...priority });
        return;
      }
      case 'meshInvalidated':
        this.scheduleInvalidatedMesh(event.entry, event.now);
        return;
      case 'chunkStored':
        this.syncTrackerEntry(event.entry, trackerTimeSeconds(event.now));
        return;
      case 'meshDisplayed':
        this.syncTrackerEntry(event.entry, trackerTimeSeconds(event.now));
        this.meshCooldownUntil.delete(event.entry.key);
        return;
      case 'chunkDropped':
        this.deleteKey(event.key);
        return;
    }
  }

  shouldAcceptMeshResult(result: SchedulerMeshResult): boolean {
    if (result.version < result.entry.displayedVersion) return false;
    if (!this.priorityFresh(result.entry, result.now)) return false;
    if (result.kind === 'full') return this.lastTargetStep(result.entry) === 1;
    if (this.lodDisabled()) return false;
    const target = this.lastTargetStep(result.entry);
    return target !== 1 && result.step <= target;
  }

  private planFrame(input: SchedulerTickInput): SchedulerFramePlan {
    const nowSeconds = trackerTimeSeconds(input.now);
    const topDownView = input.topDownView ?? false;
    const cfg = this.resolveTrackerConfig(input.camera, topDownView);
    this.lastMaxCandidates = cfg.maxCandidates;
    this.ensureTracker(cfg, input.force);

    const pose = this.poseFromCamera(input.camera);
    const ranking = this.rankCells(pose, nowSeconds, cfg);
    const centerCx = Math.floor(input.camera.position.x / CHUNK_SIZE_BLOCKS);
    const centerCz = Math.floor(input.camera.position.z / CHUNK_SIZE_BLOCKS);
    const nearPresenceCells = this.nearPresenceCells(centerCx, centerCz);
    const nearPresenceKeys = new Set(nearPresenceCells.map((cell) => input.keyFor(cell.i, cell.j)));
    const nearCriticalCells = this.nearCriticalCells(centerCx, centerCz);
    const nearCriticalKeys = new Set(nearCriticalCells.map((cell) => input.keyFor(cell.i, cell.j)));
    const criticalCells = this.criticalCellsForPose(pose, centerCx, centerCz, cfg);
    const criticalKeys = new Set(criticalCells.map((cell) => input.keyFor(cell.i, cell.j)));

    for (const cell of this.mergeRankedCells(ranking.gap.top, ranking.importance.top)) {
      this.syncTrackerCell(
        cell.i,
        cell.j,
        input.entryFor(input.keyFor(cell.i, cell.j)),
        input.cellInfoFor?.(cell.i, cell.j) ?? null,
        nowSeconds,
      );
    }

    for (const cell of nearPresenceCells) {
      this.syncTrackerCell(
        cell.i,
        cell.j,
        input.entryFor(input.keyFor(cell.i, cell.j)),
        input.cellInfoFor?.(cell.i, cell.j) ?? null,
        nowSeconds,
      );
    }

    const reranking = this.tracker?.query(cfg.maxCandidates, nowSeconds) ?? ranking;
    const criticalRankedCells = this.snapshotCriticalCells(criticalCells, nowSeconds);
    const nearPresenceRankedCells = this.snapshotCriticalCells(nearPresenceCells, nowSeconds);
    // Completed full meshes have negative gaps and normally disappear from the
    // gap ranking, which used to leave them at full detail indefinitely. Add
    // explicit downgrade candidates so they can transition to LOD as attention
    // decays, even when they are no longer in the top tracker rankings.
    const fullDowngradeCells = this.fullDowngradeCells(input.entries, nowSeconds);
    const rankedCells = this.mergeRankedCells(
      criticalRankedCells,
      nearPresenceRankedCells,
      fullDowngradeCells,
      reranking.gap.top,
      reranking.importance.top,
    );
    const keepKeys = this.activeDiskKeys(pose, cfg, input.keyFor);
    const protectedKeys = new Set<string>([...criticalKeys, ...nearPresenceKeys]);
    const candidates: ChunkCandidate[] = [];

    for (const cell of rankedCells) {
      const key = input.keyFor(cell.i, cell.j);
      const entry = input.entryFor(key);
      const info = input.cellInfoFor?.(cell.i, cell.j) ?? null;
      const critical = criticalKeys.has(key);
      const nearCritical = nearCriticalKeys.has(key);
      const nearPresence = nearPresenceKeys.has(key);
      keepKeys.add(key);

      const targetStep = critical ? 1 : this.targetStepForCell(cell, entry);
      const shouldSchedule = critical
        ? this.shouldScheduleCriticalCell(entry, info, targetStep)
        : nearPresence
          ? this.shouldScheduleNearPresenceCell(entry, info, targetStep)
        : this.shouldScheduleCell(cell, entry, info, targetStep, cfg);
      if (!shouldSchedule) continue;

      candidates.push({
        key,
        cx: cell.i,
        cz: cell.j,
        targetStep,
        importance: cell.importance,
        satisfaction: cell.satisfaction,
        gap: cell.gap,
        tier: critical
          ? this.tierForCriticalCell(entry, targetStep, nearCritical)
          : nearPresence
            ? this.tierForNearPresenceCell(entry, targetStep)
            : this.tierForCell(cell, entry, targetStep),
        score: this.scoreForCell(cell, entry, targetStep, centerCx, centerCz)
          + (nearCritical
            ? CRITICAL_NEAR_SCORE_BOOST
            : critical
              ? CRITICAL_SCORE_BOOST
              : nearPresence
                ? NEAR_PRESENCE_SCORE_BOOST
                : 0),
        updatedAt: input.now,
      });
    }

    candidates.sort((a, b) => this.comparePriority(a, b) || a.cx - b.cx || a.cz - b.cz);
    // Preserve every nearby presence candidate even when the normal frame
    // budget is saturated; otherwise the edge of the close disk can still
    // wait for a camera turn.
    const guaranteedCandidateCount = candidates.reduce(
      (count, candidate) => count + (nearPresenceKeys.has(candidate.key) ? 1 : 0),
      0,
    );
    const frameCandidateLimit = Math.max(cfg.maxFrameCandidates, guaranteedCandidateCount);
    if (candidates.length > frameCandidateLimit) candidates.length = frameCandidateLimit;
    for (const candidate of candidates) protectedKeys.add(candidate.key);

    if (isDebugLoggingEnabled()) {
      debugLog('scheduler', 'tracker-frame', {
        mode: topDownView ? 'topDown' : 'perspective',
        center: [centerCx, centerCz],
        activeRadiusChunks: cfg.activeRadiusChunks,
        activeCells: rankedCells.length,
        criticalCells: criticalCells.length,
        nearPresenceCells: nearPresenceCells.length,
        candidates: candidates.length,
        hashQueued: this.hashQueue.size,
        fetchQueued: this.fetchQueue.size,
        meshQueued: this.meshQueue.size,
      });
    }

    return { candidates, keepKeys, protectedKeys, centerCx, centerCz };
  }

  private rankCells(pose: Pose, nowSeconds: number, cfg: TrackerRuntimeConfig): RankingResult {
    const tracker = this.tracker;
    if (!tracker) return emptyRankingResult(nowSeconds);

    if (!this.trackerSeeded) {
      const seedTime = Math.max(0, nowSeconds - TRACKER_SEED_SECONDS);
      tracker.updateCamera(seedTime, pose, 0);
      this.trackerSeeded = true;
      return tracker.advanceTime(nowSeconds, cfg.maxCandidates);
    }

    return tracker.updateCamera(nowSeconds, pose, cfg.maxCandidates);
  }

  private criticalCellsForPose(
    pose: Pose,
    centerCx: number,
    centerCz: number,
    cfg: TrackerRuntimeConfig,
  ): CriticalCell[] {
    const out = this.nearCriticalCells(centerCx, centerCz);
    const seen = new Set(out.map((cell) => `${cell.i},${cell.j}`));
    const add = (i: number, j: number): void => {
      const key = `${i},${j}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ i, j });
    };

    const horizontal = Math.cos(pose.pitch);
    const dx = horizontal * Math.sin(pose.yaw);
    const dz = horizontal * Math.cos(pose.yaw);
    const len = Math.hypot(dx, dz);
    if (len < MIN_CRITICAL_RAY_HORIZONTAL) return out;

    const ux = dx / len;
    const uz = dz / len;
    const maxChunks = Math.min(cfg.activeRadiusChunks, CRITICAL_CENTER_RAY_MAX_CHUNKS);
    for (let d = CRITICAL_CENTER_RAY_STEP_CHUNKS; d <= maxChunks; d += CRITICAL_CENTER_RAY_STEP_CHUNKS) {
      add(
        Math.floor((pose.p.x + ux * d * CHUNK_SIZE_BLOCKS) / CHUNK_SIZE_BLOCKS),
        Math.floor((pose.p.z + uz * d * CHUNK_SIZE_BLOCKS) / CHUNK_SIZE_BLOCKS),
      );
    }

    return out;
  }

  private nearCriticalCells(centerCx: number, centerCz: number): CriticalCell[] {
    return this.nearPresenceCells(centerCx, centerCz, CRITICAL_NEAR_RADIUS_CHUNKS);
  }

  private nearPresenceCells(
    centerCx: number,
    centerCz: number,
    radius = NEAR_PRESENCE_RADIUS_CHUNKS,
  ): CriticalCell[] {
    const out: CriticalCell[] = [];
    for (let di = -radius; di <= radius; di++) {
      for (let dj = -radius; dj <= radius; dj++) {
        if (di * di + dj * dj > radius * radius) continue;
        out.push({ i: centerCx + di, j: centerCz + dj });
      }
    }
    return out;
  }

  private snapshotCriticalCells(cells: CriticalCell[], nowSeconds: number): RankedCell[] {
    const tracker = this.tracker;
    if (!tracker) return [];

    return cells.map((cell) => {
      const snapshot = tracker.getCellSnapshot(cell.i, cell.j, nowSeconds);
      const gap = snapshot.importance - snapshot.satisfaction;
      return {
        i: cell.i,
        j: cell.j,
        score: gap,
        importance: snapshot.importance,
        satisfaction: snapshot.satisfaction,
        gap,
      };
    });
  }

  private fullDowngradeCells(entries: Iterable<ChunkSchedulerEntry>, nowSeconds: number): RankedCell[] {
    const tracker = this.tracker;
    if (!tracker || this.lodDisabled()) return [];

    const out: RankedCell[] = [];
    for (const entry of entries) {
      if (entry.displayed !== 'full' || entry.dirty || entry.pendingFull) continue;
      const snapshot = tracker.getCellSnapshot(entry.cx, entry.cz, nowSeconds);
      const gap = snapshot.importance - snapshot.satisfaction;
      const cell: RankedCell = {
        i: entry.cx,
        j: entry.cz,
        score: gap,
        importance: snapshot.importance,
        satisfaction: snapshot.satisfaction,
        gap,
      };
      if (this.targetStepForCell(cell, entry) > 1) out.push(cell);
    }
    return out;
  }

  private mergeRankedCells(...groups: RankedCell[][]): RankedCell[] {
    const out: RankedCell[] = [];
    const seen = new Set<string>();
    for (const group of groups) {
      for (const cell of group) {
        const key = `${cell.i},${cell.j}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(cell);
      }
    }
    return out;
  }

  private activeDiskKeys(
    pose: Pose,
    cfg: TrackerRuntimeConfig,
    keyFor: (cx: number, cz: number) => string,
  ): Set<string> {
    const out = new Set<string>();
    const radius = cfg.activeRadiusBlocks;
    const radius2 = radius * radius;
    const px = pose.p.x;
    const pz = pose.p.z;

    const i0 = Math.ceil((px - radius) / CHUNK_SIZE_BLOCKS - 0.5 - ACTIVE_KEEP_EPSILON);
    const i1 = Math.floor((px + radius) / CHUNK_SIZE_BLOCKS - 0.5 + ACTIVE_KEEP_EPSILON);

    for (let i = i0; i <= i1; i++) {
      const xc = (i + 0.5) * CHUNK_SIZE_BLOCKS;
      const dx = xc - px;
      const remain = radius2 - dx * dx;
      if (remain < -ACTIVE_KEEP_EPSILON) continue;

      const zLimit = Math.sqrt(Math.max(0, remain));
      const j0 = Math.ceil((pz - zLimit) / CHUNK_SIZE_BLOCKS - 0.5 - ACTIVE_KEEP_EPSILON);
      const j1 = Math.floor((pz + zLimit) / CHUNK_SIZE_BLOCKS - 0.5 + ACTIVE_KEEP_EPSILON);

      for (let j = j0; j <= j1; j++) out.add(keyFor(i, j));
    }

    return out;
  }

  private scheduleCandidate(candidate: ChunkCandidate, entry: ChunkSchedulerEntry): { removeMesh: boolean } {
    if (entry.state === 'absent' || entry.state === 'error') return { removeMesh: true };
    if (!this.entryNeedsMoreForLastTarget(entry)) return { removeMesh: false };

    if (entry.state === 'checking') {
      this.enqueueHash(candidate.key);
      return { removeMesh: false };
    }

    if (entry.state === 'hashed' || entry.state === 'fetching') {
      if (!this.displaySatisfiesTarget(entry, candidate.targetStep)) this.enqueueFetch(candidate.key);
      return { removeMesh: false };
    }

    return { removeMesh: false };
  }

  private nextHashBatch(input: SchedulerWorkInput): string[] {
    if (input.activeHashBatches >= MAX_HASH_BATCHES) return [];
    const batchSize = this.shouldLoadMore(input)
      ? this.ioBatchSize(HASH_BATCH_SIZE, input)
      : BLOCKED_RENDER_HASH_BATCH_SIZE;
    return this.nextIoBatch(
      this.hashQueue,
      batchSize,
      (entry) => entry?.state === 'checking',
      input.entryFor,
    );
  }

  private nextFetchBatch(input: SchedulerWorkInput): string[] {
    if (input.activeFetchBatches >= MAX_FETCH_BATCHES) return [];
    const batchSize = this.shouldLoadMore(input)
      ? this.ioBatchSize(FETCH_BATCH_SIZE, input)
      : BLOCKED_RENDER_FETCH_BATCH_SIZE;
    return this.nextIoBatch(
      this.fetchQueue,
      batchSize,
      (entry) => entry?.state === 'hashed' || entry?.state === 'fetching',
      input.entryFor,
    );
  }

  private nextMeshTask(
    entryFor: (key: string) => ChunkSchedulerEntry | null,
    entries: Iterable<ChunkSchedulerEntry>,
    now: number,
    selectedKeys: ReadonlySet<string>,
  ): MeshTask | null {
    const tasks = [...this.meshQueue.values()].sort((a, b) => this.comparePriority(a, b) || a.step - b.step);
    let best: MeshTask | null = null;
    let bestQueueKey: string | null = null;

    for (const task of tasks) {
      const queueKey = priorityKey(task);
      const entry = entryFor(task.key);
      if (!entry || entry.state !== 'stored') {
        this.meshQueue.delete(queueKey);
        continue;
      }
      if (selectedKeys.has(task.key) || this.meshOnCooldown(task.key, now)) continue;
      if (!this.shouldStartMeshTask(task, entry, now)) {
        this.meshQueue.delete(queueKey);
        continue;
      }
      const queued = this.withLatestPriority(task);
      if (!best || this.compareMeshTaskPriority(queued, best) < 0) {
        best = queued;
        bestQueueKey = queueKey;
      }
    }

    for (const entry of entries) {
      if (selectedKeys.has(entry.key) || this.meshOnCooldown(entry.key, now)) continue;
      if (entry.state !== 'stored') continue;
      const task = this.desiredMeshTaskForEntry(entry, now);
      if (!task) continue;
      if (!best || this.compareMeshTaskPriority(task, best) < 0) {
        best = task;
        bestQueueKey = null;
      }
    }

    if (bestQueueKey) this.meshQueue.delete(bestQueueKey);
    if (best) this.cooldownMesh(best.key, now);
    return best;
  }

  private nextIoBatch(
    queue: Set<string>,
    batchSize: number,
    entryIsValid: (entry: ChunkSchedulerEntry | null) => boolean,
    entryFor: (key: string) => ChunkSchedulerEntry | null,
  ): string[] {
    const out: string[] = [];
    const keys = [...queue].sort((a, b) => this.compareQueuedKeys(a, b));

    for (const key of keys) {
      if (out.length >= batchSize) break;
      const entry = entryFor(key);
      if (!entryIsValid(entry)) {
        queue.delete(key);
        continue;
      }
      queue.delete(key);
      out.push(key);
    }

    return out;
  }

  private shouldLoadMore(input: SchedulerWorkInput): boolean {
    const backlog = this.renderBacklog(input.entries, input.now);
    if (backlog > RENDER_BACKLOG_IO_PAUSE && input.activeMeshTasks < input.maxMeshTasks) return false;
    if (this.renderStats.nbt < MIN_EXISTING_CHUNKS_BEFORE_BALANCE) return true;
    if (backlog <= RENDER_BACKLOG_IO_PAUSE) return true;
    return this.readyShare() >= IO_RENDER_SHARE_TARGET;
  }

  private ioBatchSize(base: number, input: SchedulerWorkInput): number {
    const backlog = this.renderBacklog(input.entries, input.now);
    if (backlog <= RENDER_BACKLOG_IO_PAUSE) return base;
    return Math.max(4, Math.floor(base / 2));
  }

  private renderBacklog(entries: Iterable<ChunkSchedulerEntry>, now: number): number {
    let backlog = 0;
    for (const entry of entries) {
      if (entry.state !== 'stored' || entry.pendingFull || entry.pendingLod) continue;
      const record = this.recordFor(entry);
      if (!record || now - record.lastWantedAt > IO_QUEUE_RETENTION_MS) continue;
      if (!this.displaySatisfiesTarget(entry, record.lastTargetStep)) backlog++;
    }
    return backlog + this.meshQueue.size;
  }

  private readyShare(): number {
    if (this.renderStats.nbt <= 0) return 0;
    return (this.renderStats.lodReady + this.renderStats.fullReady) / this.renderStats.nbt;
  }

  private enqueueHash(key: string) {
    this.hashQueue.add(key);
    this.trimQueue(this.hashQueue, MAX_IO_QUEUE);
  }

  private enqueueFetch(key: string) {
    this.fetchQueue.add(key);
    this.trimQueue(this.fetchQueue, MAX_IO_QUEUE);
  }

  private enqueueMeshTask(task: MeshTask) {
    if (this.lodDisabled() && task.kind !== 'full') return;

    const key = priorityKey(task);
    const existing = this.meshQueue.get(key);
    if (existing && this.comparePriority(existing, task) <= 0) return;

    this.meshQueue.set(key, task);
    this.trimMeshQueue();
  }

  private desiredMeshTaskForEntry(entry: ChunkSchedulerEntry, now: number): MeshTask | null {
    const record = this.recordFor(entry);
    if (!record || now - record.lastWantedAt > IO_QUEUE_RETENTION_MS) return null;
    const priority = this.priorityByKey.get(entry.key) ?? {
      tier: record.lastTier,
      score: record.lastScore,
      updatedAt: record.lastWantedAt,
    };
    const targetStep = this.lodDisabled() ? 1 : record.lastTargetStep;

    if (targetStep === 1) {
      if (entry.pendingFull || (entry.displayed === 'full' && !entry.dirty)) return null;
      return { key: entry.key, kind: 'full', step: 1, ...priority };
    }

    if (this.lodDisabled()) return null;
    if (entry.pendingLod && entry.pendingLodStep > 0 && entry.pendingLodStep <= targetStep && !entry.dirty) return null;
    if (entry.displayed === 'lod' && entry.displayedLodStep > 0 && entry.displayedLodStep <= targetStep && !entry.dirty) return null;
    return { key: entry.key, kind: 'lod', step: targetStep, ...priority };
  }

  private shouldStartMeshTask(task: MeshTask, entry: ChunkSchedulerEntry, now: number): boolean {
    if (!this.priorityFresh(entry, now)) return false;
    const target = this.lastTargetStep(entry);

    if (task.kind === 'full') {
      return target === 1 && !entry.pendingFull && (entry.displayed !== 'full' || entry.dirty);
    }

    if (this.lodDisabled() || target === 1) return false;
    if (task.step > target && entry.displayed !== 'none') return false;
    if (entry.pendingLod && entry.pendingLodStep > 0 && entry.pendingLodStep <= task.step && !entry.dirty) return false;
    if (entry.displayed === 'lod' && entry.displayedLodStep <= task.step && !entry.dirty) return false;
    return true;
  }

  private meshOnCooldown(key: string, now: number): boolean {
    const until = this.meshCooldownUntil.get(key);
    if (until === undefined) return false;
    if (now < until) return true;
    this.meshCooldownUntil.delete(key);
    return false;
  }

  private cooldownMesh(key: string, now: number) {
    this.meshCooldownUntil.set(key, now + MESH_RETRY_COOLDOWN_MS);
  }

  private pruneQueues(
    now: number,
    entryFor: (key: string) => ChunkSchedulerEntry | null,
  ) {
    const keepQueued = (key: string): boolean => this.priorityFreshByKey(key, now) || this.recordFreshByKey(key, now);

    for (const key of [...this.hashQueue]) {
      const entry = entryFor(key);
      if (!keepQueued(key) || entry?.state !== 'checking') this.hashQueue.delete(key);
    }

    for (const key of [...this.fetchQueue]) {
      const entry = entryFor(key);
      if (!keepQueued(key) || (entry?.state !== 'hashed' && entry?.state !== 'fetching')) this.fetchQueue.delete(key);
    }

    for (const [queueKey, task] of [...this.meshQueue]) {
      if (!keepQueued(task.key)) {
        this.meshQueue.delete(queueKey);
        continue;
      }
      const entry = entryFor(task.key);
      if (!entry || entry.state !== 'stored' || !this.shouldStartMeshTask(task, entry, now)) {
        this.meshQueue.delete(queueKey);
      }
    }
  }

  private expirePriorities(now: number) {
    for (const [key, priority] of [...this.priorityByKey]) {
      if (now - priority.updatedAt > RECORD_RETENTION_MS) this.priorityByKey.delete(key);
    }

    for (const [key, record] of [...this.recordByKey]) {
      if (now - record.lastWantedAt > RECORD_RETENTION_MS && !this.hashQueue.has(key) && !this.fetchQueue.has(key)) {
        this.recordByKey.delete(key);
      }
    }

    for (const [key, until] of [...this.meshCooldownUntil]) {
      if (now >= until + MESH_RETRY_COOLDOWN_MS) this.meshCooldownUntil.delete(key);
    }
  }

  private evictKeys(
    keepKeys: Set<string>,
    protectedKeys: Set<string>,
    entries: Iterable<ChunkSchedulerEntry>,
    now: number,
    reservedSlots: number,
  ): string[] {
    const out: string[] = [];
    const all = [...entries];
    const already = new Set<string>();

    for (const entry of all) {
      if (keepKeys.has(entry.key)) continue;
      const age = now - this.lastWantedAt(entry);
      if (age > OUTSIDE_ACTIVE_DROP_MS) {
        out.push(entry.key);
        already.add(entry.key);
      }
    }

    // A chunk can stay within the active disk while its attention has already
    // decayed to zero. Keeping coarse, stale islands in that case wastes both
    // resident metadata and the chance to load something useful nearby. Do not
    // touch current candidates or the critical neighborhood: those are allowed
    // to survive even when their transient tracker score is low.
    const lowValueVictims = this.evictionVictims(
      all.filter((entry) => (
        keepKeys.has(entry.key)
        && !protectedKeys.has(entry.key)
        && !already.has(entry.key)
        && this.isLowValueActiveEntry(entry, now)
      )),
      now,
      LOW_VALUE_ACTIVE_EVICT_LIMIT,
    );
    for (const victim of lowValueVictims) {
      out.push(victim.key);
      already.add(victim.key);
    }

    const activeCapacity = activeCellCapacity(this.lastActiveRadiusChunks);
    const residentLimit = Math.min(activeCapacity, MAX_TRACKED_CHUNKS);
    const existingProtectedCount = all.reduce((count, entry) => count + (protectedKeys.has(entry.key) ? 1 : 0), 0);
    const softLimit = Math.max(existingProtectedCount, residentLimit - Math.max(0, reservedSlots));
    const hardLimit = softLimit;
    if (all.length - out.length <= softLimit) return out;

    let tracked = all.length - out.length;
    const dropVictim = (victim: ChunkSchedulerEntry): void => {
      if (already.has(victim.key)) return;
      out.push(victim.key);
      already.add(victim.key);
      tracked--;
    };

    const victims = this.evictionVictims(
      all.filter((entry) => !keepKeys.has(entry.key) && !already.has(entry.key)),
      now,
      tracked - softLimit,
    );
    for (const victim of victims) {
      if (tracked <= softLimit) break;
      dropVictim(victim);
    }

    if (tracked > softLimit) {
      const staleActiveVictims = this.evictionVictims(
        all.filter((entry) => (
          keepKeys.has(entry.key)
          && !protectedKeys.has(entry.key)
          && !already.has(entry.key)
          && !this.priorityFresh(entry, now)
        )),
        now,
        tracked - softLimit,
      );
      for (const victim of staleActiveVictims) {
        if (tracked <= softLimit) break;
        dropVictim(victim);
      }
    }

    if (tracked > hardLimit) {
      const activeVictims = this.evictionVictims(
        all.filter((entry) => keepKeys.has(entry.key) && !protectedKeys.has(entry.key) && !already.has(entry.key)),
        now,
        tracked - hardLimit,
      );
      for (const victim of activeVictims) {
        if (tracked <= hardLimit) break;
        dropVictim(victim);
      }
    }

    if (out.length) {
      debugLog('scheduler', 'evict', {
        evicted: out.length,
        trackedBefore: all.length,
        trackedAfter: all.length - out.length,
        residentLimit,
        reservedSlots,
        softLimit,
        hardLimit,
      });
    }

    return out;
  }

  private evictionVictims(entries: ChunkSchedulerEntry[], now: number, limit: number): ChunkSchedulerEntry[] {
    if (limit <= 0 || entries.length === 0) return [];

    const leastImportant = [...entries].sort((a, b) => this.compareLeastImportantEviction(a, b, now));
    const saturated = [...entries].sort((a, b) => this.compareSaturatedEviction(a, b, now));
    const out: ChunkSchedulerEntry[] = [];
    const seen = new Set<string>();
    let importanceIndex = 0;
    let saturatedIndex = 0;

    const take = (entry: ChunkSchedulerEntry | undefined): void => {
      if (entry === undefined || seen.has(entry.key) || out.length >= limit) return;
      seen.add(entry.key);
      out.push(entry);
    };

    while (out.length < limit && (importanceIndex < leastImportant.length || saturatedIndex < saturated.length)) {
      take(leastImportant[importanceIndex++]);
      take(saturated[saturatedIndex++]);
    }

    return out;
  }

  private deleteKey(key: string) {
    this.hashQueue.delete(key);
    this.fetchQueue.delete(key);
    for (const [queueKey, task] of [...this.meshQueue]) {
      if (task.key === key) this.meshQueue.delete(queueKey);
    }
    this.meshCooldownUntil.delete(key);
    this.priorityByKey.delete(key);
    this.recordByKey.delete(key);
  }

  private scheduleInvalidatedMesh(entry: ChunkSchedulerEntry, now: number) {
    const previous = this.recordFor(entry);
    const displayedStep = entry.displayed === 'full'
      ? 1
      : entry.displayed === 'lod' && entry.displayedLodStep > 0
        ? entry.displayedLodStep
        : entry.pendingFull
          ? 1
          : entry.pendingLodStep;
    const targetStep = this.lodDisabled() || displayedStep === 1
      ? 1
      : normalizeLodStep(displayedStep || previous?.lastTargetStep || entry.lastTargetStep, 8);
    const priority: ChunkPriority = {
      // A boundary change affects visible geometry. Put it ahead of ordinary
      // background work, without leapfrogging the critical camera cell tier.
      tier: Math.min(previous?.lastTier ?? entry.lastTier, 0),
      score: Math.min(previous?.lastScore ?? entry.lastScore, -180),
      updatedAt: now,
    };
    const record: SchedulerRecord = {
      key: entry.key,
      cx: entry.cx,
      cz: entry.cz,
      lastWantedAt: now,
      lastTier: priority.tier,
      lastScore: priority.score,
      lastTargetStep: targetStep,
      lastForcedFull: targetStep === 1,
      lastImportance: previous?.lastImportance ?? entry.lastImportance,
      lastSatisfaction: previous?.lastSatisfaction ?? entry.lastSatisfaction,
      lastGap: previous?.lastGap ?? entry.lastGap,
    };
    this.recordByKey.set(entry.key, record);
    this.rememberPriority(entry.key, priority);
    this.syncTrackerEntry(entry, trackerTimeSeconds(now));

    if (entry.state === 'checking') {
      this.enqueueHash(entry.key);
      return;
    }
    if (entry.state === 'hashed' || entry.state === 'fetching') {
      this.enqueueFetch(entry.key);
      return;
    }
    if (entry.state !== 'stored') return;
    this.enqueueMeshTask({
      key: entry.key,
      kind: targetStep === 1 ? 'full' : 'lod',
      step: targetStep,
      ...priority,
    });
  }

  private resolveTrackerConfig(_camera: ChunkSchedulerCamera, _topDownView: boolean): TrackerRuntimeConfig {
    const scheduling = this.opts.scheduling ?? {};
    const activeRadiusChunks = clampFinite(
      scheduling.activeRadiusChunks,
      DEFAULT_ACTIVE_RADIUS_CHUNKS,
      MIN_ACTIVE_RADIUS_CHUNKS,
      MAX_ACTIVE_RADIUS_CHUNKS,
    );
    const maxCandidates = Math.max(1, Math.floor(clampFinite(
      scheduling.maxCandidates,
      activeCellCapacity(activeRadiusChunks),
      1,
      activeCellCapacity(MAX_ACTIVE_RADIUS_CHUNKS),
    )));
    const maxFrameCandidates = Math.max(1, Math.floor(clampFinite(
      scheduling.maxFrameCandidates,
      MAX_FRAME_CANDIDATES,
      1,
      activeCellCapacity(MAX_ACTIVE_RADIUS_CHUNKS),
    )));
    const tauImportance = clampFinite(scheduling.tauImportance, 0.85, 0.05, 10);
    const baseImportanceHalfLife = tauImportance * Math.LN2;
    const nearImportanceHalfLife = clampFinite(
      scheduling.nearImportanceHalfLife,
      baseImportanceHalfLife * DEFAULT_NEAR_IMPORTANCE_HALF_LIFE_RATIO,
      0.05,
      30,
    );
    const farImportanceHalfLife = Math.min(nearImportanceHalfLife, clampFinite(
      scheduling.farImportanceHalfLife,
      baseImportanceHalfLife * DEFAULT_FAR_IMPORTANCE_HALF_LIFE_RATIO,
      0.02,
      30,
    ));
    const distanceInverseSquareRadiusBlocks = scheduling.distanceInverseSquareRadiusChunks === null
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
      fovRadiusRad: scheduling.fovRadiusRad === undefined ? null : scheduling.fovRadiusRad,
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

  private ensureTracker(cfg: TrackerRuntimeConfig, force: boolean) {
    const key = trackerConfigKey(cfg);
    const radiusChanged = Math.abs(cfg.activeRadiusChunks - this.lastActiveRadiusChunks) > TRACKER_RESET_RADIUS_DELTA_CHUNKS;
    if (!force && this.tracker && this.trackerKey === key && !radiusChanged) return;

    this.tracker = new CameraGridTracker({
      k: CHUNK_SIZE_BLOCKS,
      m: cfg.activeRadiusBlocks,
      chunkSize: TRACKER_CHUNK_SIZE,
      tauImportance: cfg.tauImportance,
      nearImportanceHalfLife: cfg.nearImportanceHalfLife,
      farImportanceHalfLife: cfg.farImportanceHalfLife,
      importanceDecayDistancePower: cfg.importanceDecayDistancePower,
      tauSatisfaction: cfg.tauSatisfaction,
      angleSigmaRad: cfg.angleSigmaRad,
      fovRadiusRad: cfg.fovRadiusRad,
      distanceWeightPower: cfg.distanceWeightPower,
      distanceInverseSquareRadius: cfg.distanceInverseSquareRadiusBlocks,
      overshootEta: cfg.overshootEta,
      maxActiveCells: activeCellCapacity(cfg.activeRadiusChunks),
      initialHeight: heightForSurfaceY(DEFAULT_SURFACE_Y),
      initialPrecision: EMPTY_PRECISION,
      precisionToSatisfaction: (precision) => precision,
      neighborPrecisionEpsilon: cfg.neighborPrecisionEpsilon,
      neighborSatisfactionPenaltyByCount: cfg.neighborSatisfactionPenaltyByCount,
      minSatisfaction: cfg.minSatisfaction,
    });
    this.trackerKey = key;
    this.trackerSeeded = false;
    this.lastActiveRadiusChunks = cfg.activeRadiusChunks;
  }

  private resetTracker() {
    this.tracker = null;
    this.trackerKey = '';
    this.trackerSeeded = false;
  }

  private poseFromCamera(camera: ChunkSchedulerCamera): Pose {
    camera.updateMatrixWorld(true);
    camera.getWorldDirection(this.tmpDirection);
    const direction = this.tmpDirection.lengthSq() > 0
      ? this.tmpDirection.normalize()
      : this.tmpDirection.set(0, 0, -1);

    return {
      p: {
        x: camera.position.x,
        y: camera.position.y - CHUNK_WORLD_MIN_Y,
        z: camera.position.z,
      },
      yaw: Math.atan2(direction.x, direction.z),
      pitch: Math.asin(Math.max(-1, Math.min(1, direction.y))),
    };
  }

  private syncTrackerCell(
    i: number,
    j: number,
    entry: ChunkSchedulerEntry | null,
    info: SchedulerCellInfo | null,
    nowSeconds: number,
  ) {
    if (!this.tracker) return;
    this.tracker.setHeight(i, j, this.heightForCell(entry, info), nowSeconds);
    this.tracker.setPrecision(i, j, this.precisionForCell(entry, info), nowSeconds);
  }

  private syncTrackerEntry(entry: ChunkSchedulerEntry, nowSeconds: number) {
    if (!this.tracker) return;
    this.tracker.setHeight(entry.cx, entry.cz, this.heightForCell(entry, null), nowSeconds);
    this.tracker.setPrecision(entry.cx, entry.cz, this.precisionForCell(entry, null), nowSeconds);
  }

  private heightForCell(entry: ChunkSchedulerEntry | null, info: SchedulerCellInfo | null): number {
    const entrySurfaceY = (entry as (ChunkSchedulerEntry & { surfaceY?: number }) | null)?.surfaceY;
    if (Number.isFinite(entrySurfaceY)) return heightForSurfaceY(entrySurfaceY!);
    if (Number.isFinite(info?.topMapSurfaceY)) return heightForSurfaceY(info!.topMapSurfaceY!);
    return heightForSurfaceY(DEFAULT_SURFACE_Y);
  }

  private precisionForCell(entry: ChunkSchedulerEntry | null, info: SchedulerCellInfo | null): number {
    if (info?.hasChunkSource === false) return 1;
    if (!entry) return Number.isFinite(info?.topMapSurfaceY) ? TOP_MAP_PRECISION : EMPTY_PRECISION;
    if (entry.state === 'absent' || entry.state === 'error') {
      return 1;
    }
    if (entry.displayed === 'full') return 1;
    if (entry.displayed === 'lod') return precisionForStep(entry.displayedLodStep);
    if (entry.dirty) return 0;
    return Number.isFinite(info?.topMapSurfaceY) ? TOP_MAP_PRECISION : EMPTY_PRECISION;
  }

  private targetStepForCell(cell: RankedCell, _entry: ChunkSchedulerEntry | null): LodStep {
    if (this.lodDisabled()) return 1;
    // Satisfaction is the precision already on screen, not fresh demand. Using
    // it here made every completed full mesh permanently target step 1.
    const desiredPrecision = Math.max(cell.importance, Math.max(0, cell.gap));
    return stepForPrecisionTarget(desiredPrecision);
  }

  private shouldScheduleCell(
    cell: RankedCell,
    entry: ChunkSchedulerEntry | null,
    info: SchedulerCellInfo | null,
    targetStep: LodStep,
    cfg: TrackerRuntimeConfig,
  ): boolean {
    if (info?.hasChunkSource === false) return false;
    if (entry?.state === 'absent' || entry?.state === 'error') return false;
    if (entry && (!this.displayCoversTarget(entry, targetStep) || this.shouldDowngradeFullToLod(entry, targetStep))) return true;
    if (!entry) {
      return cell.importance >= cfg.minImportanceToSchedule || cell.gap >= cfg.minGapToSchedule;
    }
    return entry.dirty || cell.gap >= cfg.minGapToSchedule;
  }

  private shouldScheduleCriticalCell(
    entry: ChunkSchedulerEntry | null,
    info: SchedulerCellInfo | null,
    targetStep: LodStep,
  ): boolean {
    if (info?.hasChunkSource === false) return false;
    if (entry?.state === 'absent' || entry?.state === 'error') return false;
    if (!entry) return true;
    return entry.dirty || !this.displayCoversTarget(entry, targetStep);
  }

  private shouldScheduleNearPresenceCell(
    entry: ChunkSchedulerEntry | null,
    info: SchedulerCellInfo | null,
    targetStep: LodStep,
  ): boolean {
    if (info?.hasChunkSource === false) return false;
    if (entry?.state === 'absent' || entry?.state === 'error') return false;
    if (!entry) return true;
    return !this.displaySatisfiesTarget(entry, targetStep);
  }

  private tierForCell(cell: RankedCell, entry: ChunkSchedulerEntry | null, targetStep: LodStep): number {
    if (entry?.state === 'stored' && !this.displayCoversTarget(entry, targetStep)) return 0;
    // Let a stale full -> LOD replacement run before ordinary background work;
    // otherwise an old full mesh can monopolize memory while it waits behind
    // newly discovered distant chunks.
    if (entry?.state === 'stored' && this.shouldDowngradeFullToLod(entry, targetStep)) return 1;
    if (entry?.dirty) return entry.displayed === 'none' ? 1 : 4;
    if (!entry) return 2;
    if (entry.state === 'checking' || entry.state === 'hashed' || entry.state === 'fetching') return 2;
    if (targetStep === 1 && entry.displayed !== 'full') return 1;
    if (cell.gap > 0.2) return 4;
    return 5;
  }

  private tierForCriticalCell(entry: ChunkSchedulerEntry | null, targetStep: LodStep, near: boolean): number {
    const boost = near ? -2 : 0;
    if (entry?.dirty) return this.displayCoversTarget(entry, targetStep) ? 1 + boost : -3 + boost;
    if (entry?.state === 'stored' && !this.displayCoversTarget(entry, targetStep)) return -3 + boost;
    if (!entry) return -2 + boost;
    if (entry.state === 'checking' || entry.state === 'hashed' || entry.state === 'fetching') return -2 + boost;
    if (!this.displayCoversTarget(entry, targetStep)) return -1 + boost;
    return 0;
  }

  private tierForNearPresenceCell(entry: ChunkSchedulerEntry | null, targetStep: LodStep): number {
    if (!entry) return -1;
    if (entry.state === 'checking' || entry.state === 'hashed' || entry.state === 'fetching') return -1;
    if (entry.state === 'stored' && !this.displaySatisfiesTarget(entry, targetStep)) {
      return entry.displayed === 'none' ? -1 : 2;
    }
    return 3;
  }

  private scoreForCell(
    cell: RankedCell,
    entry: ChunkSchedulerEntry | null,
    targetStep: LodStep,
    centerCx: number,
    centerCz: number,
  ): number {
    const distance = Math.hypot(cell.i + 0.5 - (centerCx + 0.5), cell.j + 0.5 - (centerCz + 0.5));
    const renderBoost = entry?.state === 'stored' && !this.displaySatisfiesTarget(entry, targetStep) ? -300 : 0;
    const ioPenalty = !entry || entry.state === 'checking' || entry.state === 'hashed' || entry.state === 'fetching' ? 120 : 0;
    return renderBoost + ioPenalty - cell.gap * 1200 - cell.importance * 320 + distance * 0.7;
  }

  private rememberRecord(candidate: ChunkCandidate): SchedulerRecord {
    const record: SchedulerRecord = {
      key: candidate.key,
      cx: candidate.cx,
      cz: candidate.cz,
      lastWantedAt: candidate.updatedAt,
      lastTier: candidate.tier,
      lastScore: candidate.score,
      lastTargetStep: candidate.targetStep,
      lastForcedFull: candidate.targetStep === 1,
      lastImportance: candidate.importance,
      lastSatisfaction: candidate.satisfaction,
      lastGap: candidate.gap,
    };
    this.recordByKey.set(candidate.key, record);
    return record;
  }

  private recordFor(entry: ChunkSchedulerEntry): SchedulerRecord | null {
    const existing = this.recordByKey.get(entry.key);
    if (existing) return existing;
    if (!Number.isFinite(entry.lastWantedAt)) return null;
    return {
      key: entry.key,
      cx: entry.cx,
      cz: entry.cz,
      lastWantedAt: entry.lastWantedAt,
      lastTier: entry.lastTier,
      lastScore: entry.lastScore,
      lastTargetStep: entry.lastTargetStep,
      lastForcedFull: entry.lastForcedFull,
      lastImportance: entry.lastImportance,
      lastSatisfaction: entry.lastSatisfaction,
      lastGap: entry.lastGap,
    };
  }

  private rememberPriority(key: string, priority: ChunkPriority) {
    this.priorityByKey.set(key, {
      tier: priority.tier,
      score: priority.score,
      updatedAt: priority.updatedAt,
    });
  }

  private comparePriority(a: ChunkPriority, b: ChunkPriority): number {
    return a.tier - b.tier || a.score - b.score || b.updatedAt - a.updatedAt;
  }

  private compareMeshTaskPriority(a: MeshTask, b: MeshTask): number {
    return this.comparePriority(a, b) || a.step - b.step;
  }

  private compareQueuedKeys(a: string, b: string): number {
    const ap = this.priorityByKey.get(a) ?? { tier: 99, score: Infinity, updatedAt: 0 };
    const bp = this.priorityByKey.get(b) ?? { tier: 99, score: Infinity, updatedAt: 0 };
    return this.comparePriority(ap, bp) || a.localeCompare(b);
  }

  private withLatestPriority(task: MeshTask): MeshTask {
    const latest = this.priorityByKey.get(task.key);
    if (!latest) return task;
    return {
      ...task,
      tier: Math.min(task.tier, latest.tier),
      score: Math.min(task.score, latest.score),
      updatedAt: latest.updatedAt,
    };
  }

  private trimQueue(queue: Set<string>, limit: number) {
    if (queue.size <= limit) return;
    const kept = [...queue].sort((a, b) => this.compareQueuedKeys(a, b)).slice(0, limit);
    queue.clear();
    for (const key of kept) queue.add(key);
  }

  private trimMeshQueue() {
    if (this.meshQueue.size <= MAX_MESH_QUEUE) return;
    const kept = [...this.meshQueue.values()]
      .sort((a, b) => this.comparePriority(a, b))
      .slice(0, MAX_MESH_QUEUE);
    this.meshQueue.clear();
    for (const task of kept) this.meshQueue.set(priorityKey(task), task);
  }

  private priorityFresh(entry: ChunkSchedulerEntry, now: number): boolean {
    const record = this.recordFor(entry);
    return !!record && now - record.lastWantedAt <= IO_QUEUE_RETENTION_MS;
  }

  private priorityFreshByKey(key: string, now: number): boolean {
    const priority = this.priorityByKey.get(key);
    return !!priority && now - priority.updatedAt <= IO_QUEUE_RETENTION_MS;
  }

  private recordFreshByKey(key: string, now: number): boolean {
    const record = this.recordByKey.get(key);
    return !!record && now - record.lastWantedAt <= IO_QUEUE_RETENTION_MS;
  }

  private lastWantedAt(entry: ChunkSchedulerEntry): number {
    return this.recordFor(entry)?.lastWantedAt ?? 0;
  }

  private lastTargetStep(entry: ChunkSchedulerEntry): LodStep {
    if (this.lodDisabled()) return 1;
    return this.recordFor(entry)?.lastTargetStep ?? 8;
  }

  private entryNeedsMoreForLastTarget(entry: ChunkSchedulerEntry): boolean {
    return !this.displaySatisfiesTarget(entry, this.lastTargetStep(entry));
  }

  private displayCoversTarget(entry: ChunkSchedulerEntry, targetStep: LodStep): boolean {
    if (entry.displayed === 'none') return false;
    if (targetStep === 1) return entry.displayed === 'full';
    if (entry.displayed === 'full') return true;
    return entry.displayed === 'lod' && entry.displayedLodStep > 0 && entry.displayedLodStep <= targetStep;
  }

  private displaySatisfiesTarget(entry: ChunkSchedulerEntry, targetStep: LodStep): boolean {
    return !entry.dirty
      && this.displayCoversTarget(entry, targetStep)
      && !this.shouldDowngradeFullToLod(entry, targetStep);
  }

  private shouldDowngradeFullToLod(entry: ChunkSchedulerEntry, targetStep: LodStep): boolean {
    return !this.lodDisabled()
      && targetStep > 1
      && entry.displayed === 'full'
      && !entry.dirty;
  }

  private lodDisabled(): boolean {
    return this.opts.disableLod === true;
  }

  private compareLeastImportantEviction(a: ChunkSchedulerEntry, b: ChunkSchedulerEntry, now: number): number {
    const ai = this.evictionImportance(a);
    const bi = this.evictionImportance(b);
    if (ai !== bi) return ai - bi;
    return this.evictionScore(b, now) - this.evictionScore(a, now) || a.key.localeCompare(b.key);
  }

  private compareSaturatedEviction(a: ChunkSchedulerEntry, b: ChunkSchedulerEntry, now: number): number {
    const ag = this.evictionGap(a);
    const bg = this.evictionGap(b);
    if (ag !== bg) return ag - bg;

    const ap = this.evictionPrecision(a);
    const bp = this.evictionPrecision(b);
    if (ap !== bp) return bp - ap;

    const ai = this.evictionImportance(a);
    const bi = this.evictionImportance(b);
    if (ai !== bi) return ai - bi;

    return this.evictionScore(b, now) - this.evictionScore(a, now) || a.key.localeCompare(b.key);
  }

  private isLowValueActiveEntry(entry: ChunkSchedulerEntry, now: number): boolean {
    if (entry.pendingFull || entry.pendingLod) return false;
    if (now - this.lastWantedAt(entry) < LOW_VALUE_ACTIVE_DROP_MS) return false;
    if (this.priorityFresh(entry, now)) return false;
    if (Math.hypot(entry.cx - this.lastCenterCx, entry.cz - this.lastCenterCz) < LOW_VALUE_ACTIVE_MIN_DISTANCE_CHUNKS) {
      return false;
    }

    const importance = this.evictionImportance(entry);
    const gap = this.evictionGap(entry);
    if (importance > LOW_VALUE_ACTIVE_MAX_IMPORTANCE || gap > LOW_VALUE_ACTIVE_MAX_GAP) return false;

    // Coarse LOD islands are the common case. Also discard long-idle entries
    // that never produced a mesh, rather than letting old failed/empty work
    // occupy the tracked-chunk budget indefinitely.
    return (entry.displayed === 'lod' && entry.displayedLodStep >= 4)
      || entry.displayed === 'none';
  }

  private evictionImportance(entry: ChunkSchedulerEntry): number {
    const value = this.recordFor(entry)?.lastImportance ?? 0;
    return Number.isFinite(value) ? value : 0;
  }

  private evictionGap(entry: ChunkSchedulerEntry): number {
    const value = this.recordFor(entry)?.lastGap;
    if (Number.isFinite(value)) return value!;
    return this.evictionImportance(entry) - this.evictionPrecision(entry);
  }

  private evictionPrecision(entry: ChunkSchedulerEntry): number {
    if (entry.dirty) return 0;
    if (entry.displayed === 'full') return 1;
    if (entry.displayed === 'lod') return precisionForStep(entry.displayedLodStep);
    if (entry.state === 'absent' || entry.state === 'error') return 1;
    return 0;
  }

  private evictionScore(entry: ChunkSchedulerEntry, now: number): number {
    const age = Math.max(0, now - this.lastWantedAt(entry)) * 0.001;
    const dx = entry.cx - this.lastCenterCx;
    const dz = entry.cz - this.lastCenterCz;
    const distance = Math.hypot(dx, dz);
    const score = this.recordFor(entry)?.lastScore ?? 0;
    const unrendered = entry.displayed === 'none' ? 2 : 0;
    const notResident = entry.state !== 'stored' ? 1 : 0;
    const rendered = entry.displayed === 'full' ? -0.8 : entry.displayed === 'lod' ? -0.35 : 0;
    return age + distance * 0.18 + score * 0.01 + unrendered + notResident + rendered;
  }
}
