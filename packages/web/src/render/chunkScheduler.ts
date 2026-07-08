import * as THREE from 'three';
import { debugLog, isDebugLoggingEnabled } from '../logger';

export type ChunkState = 'checking' | 'hashed' | 'fetching' | 'decoding' | 'stored' | 'absent' | 'error';

const MAX_HASH_BATCHES = 3;
const HASH_BATCH_SIZE = 48;
const MAX_FETCH_BATCHES = 3;
const FETCH_BATCH_SIZE = 24;
const MAX_MESH_QUEUE = 256;
const MAX_IO_QUEUE = 768;
const TOP_DOWN_MAX_MESH_QUEUE = 384;
const TOP_DOWN_MAX_IO_QUEUE = 768;
const IO_QUEUE_RETENTION_MS = 2600;
const IO_RENDER_SHARE_TARGET = 0.8;
const OUTER_IO_RENDER_SHARE_TARGET = 0.45;
const MIN_EXISTING_CHUNKS_BEFORE_BALANCE = 64;
const PREDICT_LOOKAHEAD_SECONDS = 0.9;
const PREDICT_FORWARD_BLOCKS = 64;
const PREDICT_MARGIN_CHUNKS = 6;
const TOP_DOWN_OFFLINE_PREDICT_MARGIN_CHUNKS = 3;
const UNLOAD_MARGIN_CHUNKS = 8;
const TOP_DOWN_OFFLINE_UNLOAD_MARGIN_CHUNKS = 3;
const LOAD_FRUSTUM_EXTRA_DEGREES = 18;
const LOAD_ORTHO_EXTRA_BLOCKS = 64;
const SSE_TARGET_PX = 5.5;
const SSE_REFINE_PX = 6.8;
const SSE_COARSEN_PX = 3.2;
const FAST_MOVE_BLOCKS_PER_SECOND = 32;
const CHUNK_WORLD_MIN_Y = -80;
const CHUNK_WORLD_MAX_Y = 384;
const FULL_HOLD_MARGIN_CHUNKS = 2;
const MIN_FULL_LOD_SHARE = 0.34;
const FULL_PREVIEW_LOD_STEP: LodStep = 2;
const LOD_REFINE_STABILITY_MS = 120;
const LOD_COARSEN_STABILITY_MS = 900;
const PREDICT_CORRIDOR_RADIUS_CHUNKS = 2;
const FAST_PREDICT_CORRIDOR_RADIUS_CHUNKS = 4;
const IO_AGING_SCORE_PER_MS = 0.0035;
const MESH_COST_SCORE_WEIGHT = 0.018;
const CANDIDATE_COST_SCORE_WEIGHT = 0.012;
const EMPTY_COVERAGE_SCORE_BONUS = 120;
const CURRENT_FRUSTUM_SCORE_BONUS = 48;
const FORCED_FULL_SCORE_BONUS = 20;
const PREDICTED_FRUSTUM_SCORE_PENALTY = 32;
const FULL_TASK_QUOTA_SHARE = 0.35;
const MIN_COVERAGE_BACKLOG_FOR_FULL_THROTTLE = 2;
const FRONT_LOAD_SCORE_BONUS = 28;
const REAR_LOAD_SCORE_PENALTY = 48;
const FRONT_KEEP_BIAS = 1.15;
const REAR_KEEP_BIAS = 0.65;
const SIDE_KEEP_BIAS = 0.9;
const FRONT_QUEUE_RETENTION_BIAS = 1.15;
const REAR_QUEUE_RETENTION_BIAS = 0.45;
const SIDE_QUEUE_RETENTION_BIAS = 0.85;
const DIRECTIONAL_FRONT_THRESHOLD = 0.25;
const DIRECTIONAL_REAR_THRESHOLD = -0.25;
const DIRECTIONAL_IDLE_SPEED_BLOCKS_PER_SECOND = 2;

export const LOD_STEPS = [1, 2, 4, 8] as const;
export type LodStep = typeof LOD_STEPS[number];
export type MeshTaskKind = 'full' | 'lod';
export type ChunkSchedulerCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;
export type ChunkSchedulerViewMode = 'perspective' | 'topDown';

export interface ChunkSchedulingTuning {
  /**
   * Bias toward quickly covering empty chunks with preview LODs.
   * 0 disables preview-first behavior; 1 keeps the default; values > 1 favor coverage over refinement.
   */
  previewBias?: number;
  /**
   * Bias toward refinement/full meshes after chunks are already visible.
   * 0 strongly throttles refinement; 1 keeps the default; values > 1 favor refinement over preview coverage.
   */
  refinementBias?: number;
  /** Fraction of open mesh slots that full/refinement tasks may consume while preview coverage is backlogged. */
  fullTaskQuotaShare?: number;
  /** LOD step used as the first preview for chunks whose final target is full. Defaults to 2. */
  fullPreviewLodStep?: LodStep;
  /** LOD step used as the first preview for chunks whose final target is LOD 2. Defaults to 4. */
  lodPreviewStep?: LodStep;
  /** Minimum time a finer target must remain stable before refinement is scheduled. */
  refineStabilityMs?: number;
  /** Minimum time a coarser target must remain stable before coarsening is scheduled. */
  coarsenStabilityMs?: number;
  /** Number of empty, displayable chunks needed before full tasks are throttled. Defaults to 2. */
  coverageBacklogForFullThrottle?: number;
  /** Target minimum share of full chunks before full tasks get a catch-up bias. Defaults to 0.34. */
  minFullLodShare?: number;
  /** Bias toward loading chunks in the camera/velocity forward direction. Defaults to 1.25. */
  frontLoadBias?: number;
  /** Bias toward deprioritizing and evicting chunks behind the camera/velocity direction. Defaults to 1.3. */
  rearEvictBias?: number;
  /** Multiplier for front-side unload distance; values > 1 keep forward chunks longer. Defaults to 1.15. */
  frontKeepBias?: number;
  /** Multiplier for rear-side unload distance; values < 1 evict rear chunks sooner. Defaults to 0.65. */
  rearKeepBias?: number;
  /** Multiplier for side unload distance. Defaults to 0.9. */
  sideKeepBias?: number;
  /** Queue retention multiplier for forward chunks. Defaults to 1.15. */
  frontQueueRetentionBias?: number;
  /** Queue retention multiplier for rear chunks. Defaults to 0.45. */
  rearQueueRetentionBias?: number;
  /** Queue retention multiplier for side chunks. Defaults to 0.85. */
  sideQueueRetentionBias?: number;
}

export interface ChunkSchedulerOptions {
  viewDistance: number;
  lodDistance: number;
  /** When true, the scheduler never emits LOD mesh tasks and only targets full meshes. */
  disableLod?: boolean;
  /** Optional scheduler tuning; all fields are additive and backward-compatible. */
  scheduling?: ChunkSchedulingTuning;
}

export interface SchedulerLimits {
  softTrackedChunks: number;
  hardTrackedChunks: number;
  maxCandidates: number;
  maxIoQueue: number;
  maxMeshQueue: number;
  unloadDistanceChunks: number;
}

export interface ChunkSchedulingStrategy {
  readonly mode: ChunkSchedulerViewMode;
  readonly circularEviction: boolean;
  limits(opts: ChunkSchedulerOptions): SchedulerLimits;
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
  currentFrustum: boolean;
  predictedFrustum: boolean;
  forcedFull: boolean;
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
}

export interface SchedulerRecord {
  key: string;
  cx: number;
  cz: number;
  lastWantedAt: number;
  lastTier: number;
  lastScore: number;
  lastTargetStep: LodStep;
  lastForcedFull: boolean;
  stableTargetStep?: LodStep;
  pendingTargetStep?: LodStep;
  targetChangedAt?: number;
  lastRefineAt?: number;
  lastCoarsenAt?: number;
}

export interface SchedulerFramePlan {
  candidates: ChunkCandidate[];
  keepKeys: Set<string>;
  centerCx: number;
  centerCz: number;
}

export interface SchedulerCandidateDecision {
  removeMesh: boolean;
}

export interface SchedulerEntryUpdate extends SchedulerRecord {}

export type SchedulerAction =
  | { type: 'wantChunk'; key: string; cx: number; cz: number }
  | { type: 'removeMesh'; key: string }
  | { type: 'dropChunk'; key: string };

export interface SchedulerTickInput {
  camera: ChunkSchedulerCamera;
  now: number;
  force: boolean;
  viewportHeight: number;
  topDownView?: boolean;
  options: ChunkSchedulerOptions;
  keyFor: (cx: number, cz: number) => string;
  entryFor: (key: string) => ChunkSchedulerEntry | null;
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
  | { type: 'hashNeeded'; key: string }
  | { type: 'fetchNeeded'; key: string }
  | { type: 'meshDeferred'; key: string; kind: MeshTaskKind; step: LodStep; fallbackTier: number; now: number }
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

interface FrameLoadStats {
  currentFrustumTotal: number;
  currentFrustumLoaded: number;
  hasMoreCurrentFrustumChunks: boolean;
}

interface TopDownBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

class BinaryHeap<T> {
  private items: T[] = [];

  constructor(private readonly less: (a: T, b: T) => boolean) {}

  get size(): number { return this.items.length; }

  clear() { this.items.length = 0; }

  peek(): T | undefined { return this.items[0]; }

  push(item: T) {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  pop(): T | undefined {
    if (!this.items.length) return undefined;
    const out = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return out;
  }

  toArray(): T[] {
    return [...this.items];
  }

  rebuild(items: Iterable<T>) {
    this.items = [...items];
    for (let i = Math.floor(this.items.length / 2) - 1; i >= 0; i--) this.bubbleDown(i);
  }

  private bubbleUp(index: number) {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.less(this.items[index], this.items[parent])) break;
      this.swap(index, parent);
      index = parent;
    }
  }

  private bubbleDown(index: number) {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let best = index;
      if (left < this.items.length && this.less(this.items[left], this.items[best])) best = left;
      if (right < this.items.length && this.less(this.items[right], this.items[best])) best = right;
      if (best === index) break;
      this.swap(index, best);
      index = best;
    }
  }

  private swap(a: number, b: number) {
    const tmp = this.items[a];
    this.items[a] = this.items[b];
    this.items[b] = tmp;
  }
}

interface CandidateHeapNode {
  candidate: ChunkCandidate;
}

interface IoQueueNode {
  key: string;
  seq: number;
}

interface MeshQueueNode {
  queueKey: string;
  seq: number;
}

interface MeshStartBudget {
  fullRemaining: number;
  lodCoverageBacklog: number;
}

type DirectionalZone = 'front' | 'side' | 'rear';

interface DirectionalPlacement {
  zone: DirectionalZone;
  frontness: number;
  rearness: number;
}

interface NormalizedSchedulingTuning {
  previewBias: number;
  refinementBias: number;
  fullTaskQuotaShare: number;
  fullPreviewLodStep: LodStep;
  lodPreviewStep: LodStep;
  refineStabilityMs: number;
  coarsenStabilityMs: number;
  coverageBacklogForFullThrottle: number;
  minFullLodShare: number;
  frontLoadBias: number;
  rearEvictBias: number;
  frontKeepBias: number;
  rearKeepBias: number;
  sideKeepBias: number;
  frontQueueRetentionBias: number;
  rearQueueRetentionBias: number;
  sideQueueRetentionBias: number;
}

interface StableTargetState {
  lastTargetStep: LodStep;
  stableTargetStep: LodStep;
  pendingTargetStep: LodStep;
  targetChangedAt: number;
  lastRefineAt: number;
  lastCoarsenAt: number;
}

function clampFinite(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function normalizeLodStep(value: LodStep | undefined, fallback: LodStep): LodStep {
  return LOD_STEPS.includes(value as LodStep) ? value as LodStep : fallback;
}

function schedulingTuningForOptions(opts: ChunkSchedulerOptions): NormalizedSchedulingTuning {
  const raw = opts.scheduling ?? {};
  const previewBias = clampFinite(raw.previewBias, 1, 0, 4);
  const refinementBias = clampFinite(raw.refinementBias, 1, 0, 4);
  const automaticFullQuota = FULL_TASK_QUOTA_SHARE
    * Math.max(0.15, refinementBias)
    / Math.max(0.25, previewBias || 0.25);
  return {
    previewBias,
    refinementBias,
    fullTaskQuotaShare: clampFinite(raw.fullTaskQuotaShare, automaticFullQuota, 0, 1),
    fullPreviewLodStep: normalizeLodStep(raw.fullPreviewLodStep, FULL_PREVIEW_LOD_STEP),
    lodPreviewStep: normalizeLodStep(raw.lodPreviewStep, 4),
    refineStabilityMs: clampFinite(
      raw.refineStabilityMs,
      LOD_REFINE_STABILITY_MS / Math.max(0.25, refinementBias || 0.25),
      0,
      1000,
    ),
    coarsenStabilityMs: clampFinite(
      raw.coarsenStabilityMs,
      LOD_COARSEN_STABILITY_MS * Math.max(0.25, previewBias || 0.25) / Math.max(0.25, refinementBias || 0.25),
      0,
      5000,
    ),
    coverageBacklogForFullThrottle: Math.round(clampFinite(raw.coverageBacklogForFullThrottle, MIN_COVERAGE_BACKLOG_FOR_FULL_THROTTLE, 0, 64)),
    minFullLodShare: clampFinite(raw.minFullLodShare, MIN_FULL_LOD_SHARE, 0, 1),
    frontLoadBias: clampFinite(raw.frontLoadBias, 1.25, 0, 4),
    rearEvictBias: clampFinite(raw.rearEvictBias, 1.3, 0, 4),
    frontKeepBias: clampFinite(raw.frontKeepBias, FRONT_KEEP_BIAS, 0.2, 2.5),
    rearKeepBias: clampFinite(raw.rearKeepBias, REAR_KEEP_BIAS, 0.1, 2),
    sideKeepBias: clampFinite(raw.sideKeepBias, SIDE_KEEP_BIAS, 0.2, 2),
    frontQueueRetentionBias: clampFinite(raw.frontQueueRetentionBias, FRONT_QUEUE_RETENTION_BIAS, 0.1, 3),
    rearQueueRetentionBias: clampFinite(raw.rearQueueRetentionBias, REAR_QUEUE_RETENTION_BIAS, 0.05, 2),
    sideQueueRetentionBias: clampFinite(raw.sideQueueRetentionBias, SIDE_QUEUE_RETENTION_BIAS, 0.1, 2),
  };
}

function fullRadiusForOptions(opts: ChunkSchedulerOptions): number {
  return Math.max(0, Math.floor(opts.viewDistance));
}

function lodDisabledForOptions(opts: ChunkSchedulerOptions): boolean {
  return opts.disableLod === true;
}

function totalRenderRadiusForOptions(opts: ChunkSchedulerOptions): number {
  if (lodDisabledForOptions(opts)) return fullRadiusForOptions(opts);
  return Math.max(0, fullRadiusForOptions(opts) + Math.max(0, Math.floor(opts.lodDistance)));
}

class PerspectiveChunkSchedulingStrategy implements ChunkSchedulingStrategy {
  readonly mode = 'perspective' as const;
  readonly circularEviction = false;

  limits(opts: ChunkSchedulerOptions): SchedulerLimits {
    const scanRadius = totalRenderRadiusForOptions(opts) + PREDICT_MARGIN_CHUNKS;
    const hardTrackedChunks = Math.max(1536, Math.min(9000, Math.round(scanRadius * scanRadius * 2.1)));
    const softTrackedChunks = Math.max(1280, Math.round(hardTrackedChunks * 0.78));
    return {
      softTrackedChunks,
      hardTrackedChunks,
      maxCandidates: hardTrackedChunks,
      maxIoQueue: MAX_IO_QUEUE,
      maxMeshQueue: MAX_MESH_QUEUE,
      unloadDistanceChunks: scanRadius + UNLOAD_MARGIN_CHUNKS,
    };
  }
}

class TopDownChunkSchedulingStrategy implements ChunkSchedulingStrategy {
  readonly mode = 'topDown' as const;
  readonly circularEviction = true;

  limits(opts: ChunkSchedulerOptions): SchedulerLimits {
    const offlineBacked = lodDisabledForOptions(opts) || Math.max(0, Math.floor(opts.lodDistance)) === 0;
    const predictMargin = offlineBacked ? TOP_DOWN_OFFLINE_PREDICT_MARGIN_CHUNKS : PREDICT_MARGIN_CHUNKS;
    const scanRadius = totalRenderRadiusForOptions(opts) + predictMargin;
    const circleArea = scanRadius * scanRadius * Math.PI;
    const hardTrackedChunks = Math.max(offlineBacked ? 768 : 2560, Math.min(8192, Math.round(circleArea * 1.15)));
    const softTrackedChunks = Math.max(offlineBacked ? 512 : 1536, Math.min(hardTrackedChunks, Math.round(circleArea * 0.9)));
    return {
      softTrackedChunks,
      hardTrackedChunks,
      maxCandidates: hardTrackedChunks,
      maxIoQueue: offlineBacked ? Math.min(384, TOP_DOWN_MAX_IO_QUEUE) : TOP_DOWN_MAX_IO_QUEUE,
      maxMeshQueue: offlineBacked ? Math.min(192, TOP_DOWN_MAX_MESH_QUEUE) : TOP_DOWN_MAX_MESH_QUEUE,
      unloadDistanceChunks: scanRadius + (offlineBacked ? TOP_DOWN_OFFLINE_UNLOAD_MARGIN_CHUNKS : UNLOAD_MARGIN_CHUNKS),
    };
  }
}

const EMPTY_RENDER_STATS: ChunkRenderStats = {
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

export class ChunkScheduler {
  private hashQueue = new Set<string>();
  private fetchQueue = new Set<string>();
  private meshQueue = new Map<string, MeshTask>();
  private hashQueueHeap = new BinaryHeap<IoQueueNode>((a, b) => this.compareQueuedKeys(a.key, b.key) < 0);
  private fetchQueueHeap = new BinaryHeap<IoQueueNode>((a, b) => this.compareQueuedKeys(a.key, b.key) < 0);
  private meshQueueHeap = new BinaryHeap<MeshQueueNode>((a, b) => this.compareQueuedMeshNodes(a, b) < 0);
  private hashQueueSeq = new Map<string, number>();
  private fetchQueueSeq = new Map<string, number>();
  private meshQueueSeq = new Map<string, number>();
  private queueSeqCounter = 0;
  private priorityByKey = new Map<string, ChunkPriority>();
  private recordByKey = new Map<string, SchedulerRecord>();
  private renderStats: ChunkRenderStats = { ...EMPTY_RENDER_STATS };
  private profileStats: ChunkProfileStats = { ...EMPTY_PROFILE_STATS };
  private frameLoadStats: FrameLoadStats = {
    currentFrustumTotal: 0,
    currentFrustumLoaded: 0,
    hasMoreCurrentFrustumChunks: false,
  };
  private lastCameraPos = new THREE.Vector3();
  private hasCameraSample = false;
  private lastCameraSampleTime = 0;
  private cameraVelocity = new THREE.Vector3();
  private frustumMatrix = new THREE.Matrix4();
  private currentFrustum = new THREE.Frustum();
  private predictedFrustum = new THREE.Frustum();
  private predictedCameraPosition = new THREE.Vector3();
  private loadPerspectiveCamera = new THREE.PerspectiveCamera();
  private loadOrthographicCamera = new THREE.OrthographicCamera();
  private predictedOffset = new THREE.Vector3();
  private tmpForward = new THREE.Vector3();
  private tmpVelocity = new THREE.Vector3();
  private tmpBox = new THREE.Box3();
  private lastCenterCx = 0;
  private lastCenterCz = 0;
  private readonly perspectiveStrategy = new PerspectiveChunkSchedulingStrategy();
  private readonly topDownStrategy = new TopDownChunkSchedulingStrategy();
  private activeStrategy: ChunkSchedulingStrategy = this.perspectiveStrategy;
  private lastMeshTrimLogAt = 0;
  private lastIoTrimLogAt: Record<'hash' | 'fetch', number> = { hash: 0, fetch: 0 };

  // #region Lifecycle and options

  constructor(private opts: ChunkSchedulerOptions) {}

  private setOptions(opts: ChunkSchedulerOptions) {
    this.opts = opts;
  }

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
      trackedPriorities: this.priorityByKey.size,
    };
  }

  clear() {
    this.hashQueue.clear();
    this.fetchQueue.clear();
    this.meshQueue.clear();
    this.hashQueueHeap.clear();
    this.fetchQueueHeap.clear();
    this.meshQueueHeap.clear();
    this.hashQueueSeq.clear();
    this.fetchQueueSeq.clear();
    this.meshQueueSeq.clear();
    this.priorityByKey.clear();
    this.recordByKey.clear();
  }

  tick(input: SchedulerTickInput): SchedulerTickResult {
    this.setOptions(input.options);
    const frame = this.planFrame(
      input.camera,
      input.now,
      input.force,
      input.viewportHeight,
      input.keyFor,
      input.entryFor,
      input.topDownView ?? false,
    );
    this.lastCenterCx = frame.centerCx;
    this.lastCenterCz = frame.centerCz;
    const actions: SchedulerAction[] = [];
    const entryUpdates: SchedulerEntryUpdate[] = [];

    for (const candidate of frame.candidates) {
      const entry = input.entryFor(candidate.key);
      const update = this.rememberRecord(candidate, entry ?? undefined);
      entryUpdates.push(update);
      if (!entry) {
        this.enqueueHash(candidate.key);
        actions.push({ type: 'wantChunk', key: candidate.key, cx: candidate.cx, cz: candidate.cz });
        continue;
      }
      const decision = this.scheduleCandidate(candidate, entry);
      if (decision.removeMesh) actions.push({ type: 'removeMesh', key: candidate.key });
    }

    this.pruneQueues(frame.keepKeys, input.now);
    this.expirePriorities(input.now);
    const evictedKeys = this.evictKeys(frame.centerCx, frame.centerCz, frame.keepKeys, input.entries, input.now);
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
    const entries = [...input.entries];
    const includeHash = input.includeHash ?? true;
    const includeFetch = input.includeFetch ?? true;
    const includeMesh = input.includeMesh ?? true;
    const hashBatches: string[][] = [];
    const fetchBatches: string[][] = [];
    const meshTasks: MeshTask[] = [];

    if (includeHash) {
      const hashBatch = this.nextHashBatch(input.activeHashBatches, entries, input.activeMeshTasks);
      if (hashBatch.length) hashBatches.push(hashBatch);
    }
    if (includeFetch) {
      const fetchBatch = this.nextFetchBatch(input.activeFetchBatches, entries, input.activeMeshTasks);
      if (fetchBatch.length) fetchBatches.push(fetchBatch);
    }
    if (includeMesh) {
      const budget = this.meshStartBudget(entries, input.activeMeshTasks, input.maxMeshTasks);
      while (input.activeMeshTasks + meshTasks.length < input.maxMeshTasks) {
        const task = this.nextMeshTask(input.entryFor, entries, input.now, budget);
        if (!task) break;
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
        this.enqueueHash(event.key);
        return;
      case 'fetchNeeded':
        this.enqueueFetch(event.key);
        return;
      case 'meshDeferred': {
        const priority = this.priorityByKey.get(event.key) ?? { tier: event.fallbackTier, score: 0, updatedAt: event.now };
        this.enqueueMeshTask({ key: event.key, kind: event.kind, step: event.step, ...priority });
        return;
      }
      case 'chunkStored':
        this.scheduleStoredFromLastPriority(event.entry, event.now);
        return;
      case 'meshDisplayed':
        if (event.kind === 'lod' && this.lastTargetStep(event.entry) === 1) {
          this.scheduleStoredFromLastPriority(event.entry, event.now);
        }
        return;
      case 'chunkDropped':
        this.deleteKey(event.key);
        return;
    }
  }

  shouldAcceptMeshResult(result: SchedulerMeshResult): boolean {
    return result.kind === 'full'
      ? this.shouldApplyFullResult(result.entry, result.version, result.now)
      : this.shouldApplyLodResult(result.entry, result.step, result.version, result.now);
  }

  // #endregion

  // #region Frame planning

  private planFrame(
    camera: ChunkSchedulerCamera,
    now: number,
    force: boolean,
    viewportHeight: number,
    keyFor: (cx: number, cz: number) => string,
    entryFor: (key: string) => ChunkSchedulerEntry | null,
    topDownView = false,
  ): SchedulerFramePlan {
    this.activeStrategy = topDownView ? this.topDownStrategy : this.perspectiveStrategy;
    camera.updateMatrixWorld(true);
    this.updateCameraVelocity(camera.position, now, force);
    this.updateFrustums(camera);
    const candidates = this.buildCandidates(camera, viewportHeight, now, keyFor, entryFor, topDownView);
    this.updateFrameLoadStats(candidates, entryFor);
    if (isDebugLoggingEnabled()) {
      const limits = this.activeLimits();
      debugLog('scheduler', 'frame', {
        mode: this.activeStrategy.mode,
        center: [Math.floor(camera.position.x / 16), Math.floor(camera.position.z / 16)],
        candidates: candidates.length,
        currentFrustumTotal: this.frameLoadStats.currentFrustumTotal,
        currentFrustumLoaded: this.frameLoadStats.currentFrustumLoaded,
        currentFrustumLoadShare: this.currentFrustumLoadShare(),
        hasMoreCurrentFrustumChunks: this.frameLoadStats.hasMoreCurrentFrustumChunks,
        hashQueued: this.hashQueue.size,
        fetchQueued: this.fetchQueue.size,
        meshQueued: this.meshQueue.size,
        trackedPriorities: this.priorityByKey.size,
        softTrackedChunks: limits.softTrackedChunks,
        hardTrackedChunks: limits.hardTrackedChunks,
      });
    }
    const keepKeys = new Set(candidates.map((candidate) => candidate.key));
    for (const candidate of candidates) this.rememberPriority(candidate.key, candidate);
    return {
      candidates,
      keepKeys,
      centerCx: Math.floor(camera.position.x / 16),
      centerCz: Math.floor(camera.position.z / 16),
    };
  }

  // #endregion

  // #region Scheduling decisions

  private scheduleCandidate(candidate: ChunkCandidate, e: ChunkSchedulerEntry): SchedulerCandidateDecision {
    if (e.state === 'absent' || e.state === 'error') return { removeMesh: true };
    if (e.state === 'checking') {
      this.enqueueHash(candidate.key);
      return { removeMesh: false };
    }
    if ((e.state === 'hashed' || e.state === 'fetching') && this.displaySatisfiesTarget(e, candidate.targetStep)) {
      return { removeMesh: false };
    }
    if (e.state === 'hashed' || e.state === 'fetching') {
      this.enqueueFetch(candidate.key);
      return { removeMesh: false };
    }
    if (e.state !== 'stored') return { removeMesh: false };

    this.enqueueDesiredMeshTask(candidate.key, e, candidate.targetStep, candidate);
    return { removeMesh: false };
  }

  private scheduleStoredFromLastPriority(e: ChunkSchedulerEntry, now: number) {
    const record = this.recordFor(e);
    if (e.state !== 'stored' || !record || now - record.lastWantedAt > IO_QUEUE_RETENTION_MS) return;
    const priority = this.priorityByKey.get(e.key) ?? { tier: record.lastTier, score: record.lastScore, updatedAt: record.lastWantedAt };
    this.enqueueDesiredMeshTask(e.key, e, record.lastTargetStep, priority);
  }

  private nextMeshTask(
    entryFor: (key: string) => ChunkSchedulerEntry | null,
    _entries: Iterable<ChunkSchedulerEntry>,
    now: number,
    budget: MeshStartBudget,
  ): MeshTask | null {
    const skipped: MeshQueueNode[] = [];
    try {
      while (this.meshQueue.size > 0) {
        const node = this.meshQueueHeap.pop() ?? this.rebuildMeshQueueHeapAndPop();
        if (!node) return null;
        if (!this.validMeshQueueNode(node)) continue;
        const task = this.currentMeshTask(node.queueKey)!;
        const e = entryFor(task.key);
        if (!e || e.state !== 'stored') {
          this.removeMeshQueueKey(node.queueKey);
          continue;
        }
        if (!this.shouldStartMeshTask(task, e, now)) {
          this.removeMeshQueueKey(node.queueKey);
          continue;
        }
        if (!this.meshTaskWithinBudget(task, e, budget)) {
          skipped.push(node);
          continue;
        }
        this.removeMeshQueueKey(node.queueKey);
        this.consumeMeshBudget(task, e, budget);
        return this.withLatestPriority(task);
      }
      return null;
    } finally {
      for (const node of skipped) {
        if (this.validMeshQueueNode(node)) this.meshQueueHeap.push(node);
      }
    }
  }

  private priorityFresh(e: ChunkSchedulerEntry, now: number, maxAge?: number): boolean {
    const record = this.recordFor(e);
    const ageLimit = maxAge ?? this.ioRetentionMsForKey(e.key);
    return !!record && now - record.lastWantedAt <= ageLimit;
  }

  private shouldApplyFullResult(e: ChunkSchedulerEntry, _version: number, now: number): boolean {
    if (!this.priorityFresh(e, now)) return false;
    return this.lastTargetStep(e) === 1;
  }

  private shouldApplyLodResult(e: ChunkSchedulerEntry, step: LodStep, version: number, now: number): boolean {
    if (this.lodDisabled()) return false;
    if (version < e.displayedVersion || !this.priorityFresh(e, now)) return false;
    const targetStep = this.lastTargetStep(e);
    if (targetStep === 1) return e.displayed === 'none';
    if (step > targetStep && e.displayed !== 'none') return false;
    if (e.displayed === 'full' && this.lastTier(e) <= 3 && !e.dirty) return false;
    return true;
  }

  // #endregion

  // #region Queue operations

  private nextHashBatch(activeBatches: number, entries: Iterable<ChunkSchedulerEntry>, activeMeshTasks: number): string[] {
    return this.nextLimitedIoBatch(this.hashQueue, {
      activeBatches,
      maxBatches: MAX_HASH_BATCHES,
      batchSize: HASH_BATCH_SIZE,
      busyBatchFloor: 12,
      entries,
      activeMeshTasks,
    });
  }

  private nextFetchBatch(activeBatches: number, entries: Iterable<ChunkSchedulerEntry>, activeMeshTasks: number): string[] {
    return this.nextLimitedIoBatch(this.fetchQueue, {
      activeBatches,
      maxBatches: MAX_FETCH_BATCHES,
      batchSize: FETCH_BATCH_SIZE,
      busyBatchFloor: 8,
      entries,
      activeMeshTasks,
    });
  }

  private pruneQueues(keepKeys: Set<string>, now: number) {
    const keepIo = (key: string) => {
      const priority = this.priorityByKey.get(key);
      return keepKeys.has(key) || (!!priority && now - priority.updatedAt < this.ioRetentionMsForKey(key));
    };
    for (const key of this.hashQueue) if (!keepIo(key)) {
      this.hashQueue.delete(key);
      this.hashQueueSeq.delete(key);
    }
    for (const key of this.fetchQueue) if (!keepIo(key)) {
      this.fetchQueue.delete(key);
      this.fetchQueueSeq.delete(key);
    }
    for (const [queueKey, task] of this.meshQueue) {
      if (!keepKeys.has(task.key) && !this.priorityFreshByKey(task.key, now)) this.removeMeshQueueKey(queueKey);
    }
    this.trimIoQueue('hash');
    this.trimIoQueue('fetch');
    this.trimMeshQueue();
  }

  private expirePriorities(now: number) {
    for (const [key, priority] of this.priorityByKey) {
      if (now - priority.updatedAt > this.ioRetentionMsForKey(key)) this.priorityByKey.delete(key);
    }
  }

  private evictKeys(ccx: number, ccz: number, keepKeys: Set<string>, entries: Iterable<ChunkSchedulerEntry>, now: number): string[] {
    const out: string[] = [];
    const limits = this.activeLimits();
    const unloadDistance = limits.unloadDistanceChunks;
    const tuning = this.tuning();
    const all = [...entries];
    const rearEvicted: string[] = [];
    for (const e of all) {
      const d = this.evictionDistance(e.cx, e.cz, ccx, ccz);
      const placement = this.directionalPlacement(e.cx, e.cz, ccx, ccz);
      const keepMultiplier = placement.zone === 'front'
        ? tuning.frontKeepBias
        : placement.zone === 'rear'
          ? tuning.rearKeepBias
          : tuning.sideKeepBias;
      if (!keepKeys.has(e.key) && d > unloadDistance * keepMultiplier) {
        out.push(e.key);
        if (placement.zone === 'rear') rearEvicted.push(e.key);
      }
    }

    if (all.length - out.length <= limits.softTrackedChunks) return out;
    const already = new Set(out);
    const victims = all
      .filter((e) => !keepKeys.has(e.key) && !already.has(e.key))
      .sort((a, b) => this.evictionVictimScore(b, now, ccx, ccz) - this.evictionVictimScore(a, now, ccx, ccz));
    let tracked = all.length - out.length;
    for (const e of victims) {
      if (tracked <= limits.softTrackedChunks) break;
      const placement = this.directionalPlacement(e.cx, e.cz, ccx, ccz);
      const freshnessGuardMs = placement.zone === 'rear'
        ? Math.round(1000 / Math.max(1, tuning.rearEvictBias))
        : placement.zone === 'front'
          ? 1400
          : 1000;
      if (tracked <= limits.hardTrackedChunks && now - this.lastWantedAt(e) < freshnessGuardMs) continue;
      out.push(e.key);
      if (placement.zone === 'rear') rearEvicted.push(e.key);
      tracked--;
    }
    if (out.length) {
      debugLog('scheduler', 'evict', {
        mode: this.activeStrategy.mode,
        evicted: out.length,
        rearEvicted: rearEvicted.length,
        trackedBefore: all.length,
        trackedAfter: all.length - out.length,
        softTrackedChunks: limits.softTrackedChunks,
        hardTrackedChunks: limits.hardTrackedChunks,
        frontKeepBias: tuning.frontKeepBias,
        rearKeepBias: tuning.rearKeepBias,
        sideKeepBias: tuning.sideKeepBias,
      });
    }
    return out;
  }

  private enqueueHash(key: string) {
    this.hashQueue.add(key);
    this.pushIoQueueNode('hash', key);
  }

  private enqueueFetch(key: string) {
    this.fetchQueue.add(key);
    this.pushIoQueueNode('fetch', key);
  }

  private enqueueMeshTask(task: MeshTask) {
    const queueKey = this.meshQueueKey(task);
    const existing = this.meshQueue.get(queueKey);
    if (existing && this.compareMeshTasks(existing, task, false) <= 0) return;
    this.meshQueue.set(queueKey, task);
    this.pushMeshQueueNode(queueKey);
    this.trimMeshQueue();
  }

  private deleteKey(key: string) {
    this.hashQueue.delete(key);
    this.fetchQueue.delete(key);
    this.hashQueueSeq.delete(key);
    this.fetchQueueSeq.delete(key);
    for (const [queueKey, task] of this.meshQueue) {
      if (task.key === key) this.removeMeshQueueKey(queueKey);
    }
    this.priorityByKey.delete(key);
    this.recordByKey.delete(key);
  }

  // #endregion

  // #region Camera prediction

  private updateCameraVelocity(cameraPos: THREE.Vector3, now: number, force: boolean) {
    if (!this.hasCameraSample || force) {
      this.lastCameraPos.copy(cameraPos);
      this.lastCameraSampleTime = now;
      this.cameraVelocity.set(0, 0, 0);
      this.hasCameraSample = true;
      return;
    }
    const dt = Math.max(0.001, Math.min(0.5, (now - this.lastCameraSampleTime) / 1000));
    const instantX = (cameraPos.x - this.lastCameraPos.x) / dt;
    const instantY = (cameraPos.y - this.lastCameraPos.y) / dt;
    const instantZ = (cameraPos.z - this.lastCameraPos.z) / dt;
    this.tmpVelocity.set(instantX, instantY, instantZ);
    this.cameraVelocity.lerp(this.tmpVelocity, 0.35);
    this.lastCameraPos.copy(cameraPos);
    this.lastCameraSampleTime = now;
  }

  private updateFrustums(camera: ChunkSchedulerCamera) {
    this.setLoadFrustum(camera, this.currentFrustum);
    camera.getWorldDirection(this.tmpForward);
    this.predictedOffset.copy(this.cameraVelocity).multiplyScalar(PREDICT_LOOKAHEAD_SECONDS);
    if (camera instanceof THREE.PerspectiveCamera) {
      const forwardBoost = Math.min(
        Math.max(PREDICT_FORWARD_BLOCKS, this.cameraVelocity.length() * 0.35),
        (this.totalRenderRadius() + PREDICT_MARGIN_CHUNKS) * 16,
      );
      this.predictedOffset.addScaledVector(this.tmpForward, forwardBoost);
    }
    this.predictedCameraPosition.copy(camera.position).add(this.predictedOffset);
    if (camera instanceof THREE.PerspectiveCamera) {
      this.loadPerspectiveCamera.copy(camera);
      this.loadPerspectiveCamera.position.copy(this.predictedCameraPosition);
      this.setLoadFrustum(this.loadPerspectiveCamera, this.predictedFrustum);
    } else {
      this.loadOrthographicCamera.copy(camera);
      this.loadOrthographicCamera.position.copy(this.predictedCameraPosition);
      this.setLoadFrustum(this.loadOrthographicCamera, this.predictedFrustum);
    }
  }

  private setLoadFrustum(source: ChunkSchedulerCamera, frustum: THREE.Frustum) {
    const target = source instanceof THREE.PerspectiveCamera ? this.loadPerspectiveCamera : this.loadOrthographicCamera;
    target.copy(source as never);
    if (target instanceof THREE.PerspectiveCamera) {
      target.fov = Math.min(120, source instanceof THREE.PerspectiveCamera ? source.fov + LOAD_FRUSTUM_EXTRA_DEGREES : target.fov);
    } else {
      target.left -= LOAD_ORTHO_EXTRA_BLOCKS;
      target.right += LOAD_ORTHO_EXTRA_BLOCKS;
      target.top += LOAD_ORTHO_EXTRA_BLOCKS;
      target.bottom -= LOAD_ORTHO_EXTRA_BLOCKS;
    }
    target.updateProjectionMatrix();
    target.updateMatrixWorld(true);
    this.frustumMatrix.multiplyMatrices(target.projectionMatrix, target.matrixWorldInverse);
    frustum.setFromProjectionMatrix(this.frustumMatrix);
  }

  // #endregion

  // #region Candidate geometry and LOD

  private buildCandidates(
    camera: ChunkSchedulerCamera,
    viewportHeight: number,
    now: number,
    keyFor: (cx: number, cz: number) => string,
    entryFor: (key: string) => ChunkSchedulerEntry | null,
    topDownView: boolean,
  ): ChunkCandidate[] {
    const ccx = Math.floor(camera.position.x / 16);
    const ccz = Math.floor(camera.position.z / 16);
    const predictedX = camera.position.x + this.predictedOffset.x;
    const predictedZ = camera.position.z + this.predictedOffset.z;
    const pcx = Math.floor(predictedX / 16);
    const pcz = Math.floor(predictedZ / 16);
    const fullRadius = this.fullRadius();
    const total = this.totalRenderRadius();
    const predictMargin = topDownView && this.totalRenderRadius() === this.fullRadius()
      ? TOP_DOWN_OFFLINE_PREDICT_MARGIN_CHUNKS
      : PREDICT_MARGIN_CHUNKS;
    const scanRadius = total + predictMargin;
    const movingFast = this.cameraVelocity.length() > FAST_MOVE_BLOCKS_PER_SECOND;
    const minCx = Math.min(ccx, pcx) - scanRadius;
    const maxCx = Math.max(ccx, pcx) + scanRadius;
    const minCz = Math.min(ccz, pcz) - scanRadius;
    const maxCz = Math.max(ccz, pcz) + scanRadius;
    const topBounds = topDownView ? this.topDownBounds(camera) : null;
    const limit = this.activeLimits().maxCandidates;
    const topK = new BinaryHeap<CandidateHeapNode>((a, b) => this.compareCandidates(b.candidate, a.candidate) < 0);

    const pushCandidate = (candidate: ChunkCandidate) => {
      if (limit <= 0) return;
      if (topK.size < limit) {
        topK.push({ candidate });
        return;
      }
      const worst = topK.peek();
      if (worst && this.compareCandidates(candidate, worst.candidate) < 0) {
        topK.pop();
        topK.push({ candidate });
      }
    };

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const currentRadius = topDownView
          ? this.chunkDistanceInChunks(camera.position, cx, cz)
          : Math.max(Math.abs(cx - ccx), Math.abs(cz - ccz));
        const predictedRadius = topDownView
          ? this.chunkDistanceInChunks(this.predictedCameraPosition, cx, cz)
          : Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz));
        const forcedFull = currentRadius <= fullRadius;
        const inPredictionCorridor = this.chunkInPredictionCorridor(cx, cz, ccx, ccz, pcx, pcz, movingFast);
        if (!forcedFull && currentRadius > total && (!inPredictionCorridor || predictedRadius > total + predictMargin)) continue;

        const currentFrustum = topDownView
          ? currentRadius <= total && (forcedFull || this.chunkIntersectsTopDownBounds(topBounds, cx, cz))
          : currentRadius <= total && (forcedFull || this.chunkIntersectsFrustum(this.currentFrustum, cx, cz));
        const predictedFrustum = !currentFrustum
          && inPredictionCorridor
          && predictedRadius <= total + predictMargin
          && (topDownView || this.chunkIntersectsFrustum(this.predictedFrustum, cx, cz));
        if (!forcedFull && !currentFrustum && !predictedFrustum) continue;

        const key = keyFor(cx, cz);
        const e = entryFor(key) ?? undefined;
        const distCurrent = this.distanceToChunk(camera.position, cx, cz);
        const distPredicted = this.distanceToChunk(this.predictedCameraPosition, cx, cz);
        const sseDistance = currentFrustum || forcedFull ? distCurrent : distPredicted;
        let targetStep = this.selectLodStep(sseDistance, camera, viewportHeight, e, currentRadius, predictedFrustum, movingFast);
        if (
          targetStep !== 1
          && !predictedFrustum
          && currentRadius <= fullRadius + FULL_HOLD_MARGIN_CHUNKS
          && this.hasDisplayedFullNeighbor(cx, cz, keyFor, entryFor)
        ) {
          targetStep = 1;
        }
        if (predictedFrustum && !forcedFull) targetStep = Math.max(targetStep, movingFast ? 4 : 2) as LodStep;
        const tier = this.tierForCandidate(e, targetStep, currentFrustum, predictedFrustum, forcedFull);
        const score = this.candidateScore({
          e,
          cx,
          cz,
          centerCx: ccx,
          centerCz: ccz,
          targetStep,
          distance: currentFrustum || forcedFull ? distCurrent : distPredicted,
          sseDistance,
          camera,
          viewportHeight,
          currentFrustum,
          predictedFrustum,
          forcedFull,
        });
        pushCandidate({ key, cx, cz, targetStep, currentFrustum, predictedFrustum, forcedFull, tier, score, updatedAt: now });
      }
    }

    return topK.toArray().map((node) => node.candidate).sort((a, b) => this.compareCandidates(a, b));
  }

  private chunkIntersectsFrustum(frustum: THREE.Frustum, cx: number, cz: number): boolean {
    const x = cx * 16;
    const z = cz * 16;
    this.tmpBox.min.set(x, CHUNK_WORLD_MIN_Y, z);
    this.tmpBox.max.set(x + 16, CHUNK_WORLD_MAX_Y, z + 16);
    return frustum.intersectsBox(this.tmpBox);
  }

  private topDownBounds(camera: ChunkSchedulerCamera): TopDownBounds {
    let width = 1024;
    let height = 1024;
    if (camera instanceof THREE.OrthographicCamera) {
      width = (camera.right - camera.left) / Math.max(1e-3, camera.zoom);
      height = (camera.top - camera.bottom) / Math.max(1e-3, camera.zoom);
    } else if (camera instanceof THREE.PerspectiveCamera) {
      height = 2 * Math.max(1, camera.position.y) * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
      width = height * camera.aspect;
    }
    const margin = LOAD_ORTHO_EXTRA_BLOCKS;
    return {
      minX: camera.position.x - width / 2 - margin,
      maxX: camera.position.x + width / 2 + margin,
      minZ: camera.position.z - height / 2 - margin,
      maxZ: camera.position.z + height / 2 + margin,
    };
  }

  private chunkIntersectsTopDownBounds(bounds: TopDownBounds | null, cx: number, cz: number): boolean {
    if (!bounds) return true;
    const x = cx * 16;
    const z = cz * 16;
    return x + 16 >= bounds.minX && x <= bounds.maxX && z + 16 >= bounds.minZ && z <= bounds.maxZ;
  }

  private hasDisplayedFullNeighbor(
    cx: number,
    cz: number,
    keyFor: (cx: number, cz: number) => string,
    entryFor: (key: string) => ChunkSchedulerEntry | null,
  ): boolean {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        if (entryFor(keyFor(cx + dx, cz + dz))?.displayed === 'full') return true;
      }
    }
    return false;
  }

  private distanceToChunk(pos: THREE.Vector3, cx: number, cz: number): number {
    const minX = cx * 16;
    const maxX = minX + 16;
    const minZ = cz * 16;
    const maxZ = minZ + 16;
    const dx = pos.x < minX ? minX - pos.x : pos.x > maxX ? pos.x - maxX : 0;
    const dy = pos.y < CHUNK_WORLD_MIN_Y ? CHUNK_WORLD_MIN_Y - pos.y : pos.y > CHUNK_WORLD_MAX_Y ? pos.y - CHUNK_WORLD_MAX_Y : 0;
    const dz = pos.z < minZ ? minZ - pos.z : pos.z > maxZ ? pos.z - maxZ : 0;
    return Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }

  private chunkDistanceInChunks(pos: THREE.Vector3, cx: number, cz: number): number {
    const dx = cx + 0.5 - pos.x / 16;
    const dz = cz + 0.5 - pos.z / 16;
    return Math.sqrt(dx * dx + dz * dz);
  }

  private schedulingDirection(): { x: number; z: number; active: boolean } {
    const velocityX = this.cameraVelocity.x;
    const velocityZ = this.cameraVelocity.z;
    const velocityLen = Math.hypot(velocityX, velocityZ);
    const forwardX = this.tmpForward.x;
    const forwardZ = this.tmpForward.z;
    const forwardLen = Math.hypot(forwardX, forwardZ);
    let x = 0;
    let z = 0;
    if (velocityLen > DIRECTIONAL_IDLE_SPEED_BLOCKS_PER_SECOND) {
      const velocityWeight = Math.min(0.8, Math.max(0.45, velocityLen / Math.max(1, FAST_MOVE_BLOCKS_PER_SECOND)));
      x += (velocityX / velocityLen) * velocityWeight;
      z += (velocityZ / velocityLen) * velocityWeight;
      if (forwardLen > 1e-3) {
        x += (forwardX / forwardLen) * (1 - velocityWeight);
        z += (forwardZ / forwardLen) * (1 - velocityWeight);
      }
    } else if (forwardLen > 1e-3) {
      x = forwardX / forwardLen;
      z = forwardZ / forwardLen;
    }
    const len = Math.hypot(x, z);
    if (len <= 1e-3) return { x: 0, z: 0, active: false };
    return { x: x / len, z: z / len, active: true };
  }

  private directionalPlacement(cx: number, cz: number, centerCx: number, centerCz: number): DirectionalPlacement {
    const dir = this.schedulingDirection();
    if (!dir.active) return { zone: 'side', frontness: 0, rearness: 0 };
    const relX = cx + 0.5 - (centerCx + 0.5);
    const relZ = cz + 0.5 - (centerCz + 0.5);
    const distance = Math.hypot(relX, relZ);
    if (distance <= 1e-3) return { zone: 'front', frontness: 0.25, rearness: 0 };
    const cosine = (relX * dir.x + relZ * dir.z) / distance;
    const frontness = Math.max(0, cosine);
    const rearness = Math.max(0, -cosine);
    const zone: DirectionalZone = cosine >= DIRECTIONAL_FRONT_THRESHOLD
      ? 'front'
      : cosine <= DIRECTIONAL_REAR_THRESHOLD
        ? 'rear'
        : 'side';
    return { zone, frontness, rearness };
  }

  private evictionDistance(cx: number, cz: number, centerCx: number, centerCz: number): number {
    return this.activeStrategy.circularEviction
      ? Math.hypot(cx - centerCx, cz - centerCz)
      : Math.max(Math.abs(cx - centerCx), Math.abs(cz - centerCz));
  }

  private ioRetentionMsForKey(key: string): number {
    const tuning = this.tuning();
    const record = this.recordByKey.get(key);
    if (!record) return IO_QUEUE_RETENTION_MS * tuning.sideQueueRetentionBias;
    const placement = this.directionalPlacement(record.cx, record.cz, this.lastCenterCx, this.lastCenterCz);
    const multiplier = placement.zone === 'front'
      ? tuning.frontQueueRetentionBias
      : placement.zone === 'rear'
        ? tuning.rearQueueRetentionBias
        : tuning.sideQueueRetentionBias;
    return IO_QUEUE_RETENTION_MS * multiplier;
  }

  private priorityFreshByKey(key: string, now: number): boolean {
    const priority = this.priorityByKey.get(key);
    return !!priority && now - priority.updatedAt <= this.ioRetentionMsForKey(key);
  }

  private evictionVictimScore(e: ChunkSchedulerEntry, now: number, centerCx: number, centerCz: number): number {
    const tuning = this.tuning();
    const placement = this.directionalPlacement(e.cx, e.cz, centerCx, centerCz);
    const ageMs = Math.max(0, now - this.lastWantedAt(e));
    const score = Number.isFinite(this.lastScore(e)) ? this.lastScore(e) : 0;
    const distance = this.evictionDistance(e.cx, e.cz, centerCx, centerCz);
    const directionalPenalty = placement.zone === 'rear'
      ? 25 * tuning.rearEvictBias * Math.max(0.5, placement.rearness)
      : placement.zone === 'front'
        ? -16 * tuning.frontKeepBias * Math.max(0.5, placement.frontness)
        : 4 * tuning.sideKeepBias;
    return ageMs * 0.001 + score * 0.02 + distance * 0.15 + directionalPenalty;
  }

  private chunkInPredictionCorridor(
    cx: number,
    cz: number,
    ccx: number,
    ccz: number,
    pcx: number,
    pcz: number,
    movingFast: boolean,
  ): boolean {
    const radius = movingFast ? FAST_PREDICT_CORRIDOR_RADIUS_CHUNKS : PREDICT_CORRIDOR_RADIUS_CHUNKS;
    const ax = ccx + 0.5;
    const az = ccz + 0.5;
    const bx = pcx + 0.5;
    const bz = pcz + 0.5;
    const px = cx + 0.5;
    const pz = cz + 0.5;
    const vx = bx - ax;
    const vz = bz - az;
    const lenSq = vx * vx + vz * vz;
    if (lenSq <= 1e-3) return Math.hypot(px - ax, pz - az) <= radius;
    const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / lenSq));
    const closestX = ax + vx * t;
    const closestZ = az + vz * t;
    return Math.hypot(px - closestX, pz - closestZ) <= radius;
  }

  private candidateScore(input: {
    e: ChunkSchedulerEntry | undefined;
    cx: number;
    cz: number;
    centerCx: number;
    centerCz: number;
    targetStep: LodStep;
    distance: number;
    sseDistance: number;
    camera: ChunkSchedulerCamera;
    viewportHeight: number;
    currentFrustum: boolean;
    predictedFrustum: boolean;
    forcedFull: boolean;
  }): number {
    const tuning = this.tuning();
    const empty = !input.e || input.e.displayed === 'none';
    const placement = this.directionalPlacement(input.cx, input.cz, input.centerCx, input.centerCz);
    let score = input.distance - this.screenErrorForStep(input.targetStep, input.sseDistance, input.camera, input.viewportHeight) * 8;
    if (empty) score -= EMPTY_COVERAGE_SCORE_BONUS * tuning.previewBias;
    if (input.currentFrustum) score -= CURRENT_FRUSTUM_SCORE_BONUS;
    if (input.forcedFull) score -= FORCED_FULL_SCORE_BONUS * Math.max(0.25, tuning.refinementBias);
    if (input.predictedFrustum) score += PREDICTED_FRUSTUM_SCORE_PENALTY;
    score -= FRONT_LOAD_SCORE_BONUS * tuning.frontLoadBias * placement.frontness;
    score += REAR_LOAD_SCORE_PENALTY * tuning.rearEvictBias * placement.rearness;
    score += this.estimateCandidateCost(input.e, input.targetStep) * CANDIDATE_COST_SCORE_WEIGHT;
    return score;
  }

  private compareCandidates(a: ChunkCandidate, b: ChunkCandidate): number {
    return a.tier - b.tier || a.score - b.score || b.updatedAt - a.updatedAt || a.cx - b.cx || a.cz - b.cz;
  }

  private fullRadius(): number {
    return fullRadiusForOptions(this.opts);
  }

  private totalRenderRadius(): number {
    return totalRenderRadiusForOptions(this.opts);
  }

  private lodDisabled(): boolean {
    return lodDisabledForOptions(this.opts);
  }

  private tuning(): NormalizedSchedulingTuning {
    return schedulingTuningForOptions(this.opts);
  }

  private screenErrorForStep(step: LodStep, distance: number, camera: ChunkSchedulerCamera, viewportHeight: number): number {
    const pixelsPerBlock = camera instanceof THREE.OrthographicCamera
      ? Math.max(1, viewportHeight) / Math.max(1e-3, (camera.top - camera.bottom) / camera.zoom)
      : Math.max(1, viewportHeight) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) * Math.max(1, distance));
    const geometricError = step <= 1 ? 0.5 : step * 0.75;
    return geometricError * pixelsPerBlock;
  }

  private baseLodStep(distance: number, camera: ChunkSchedulerCamera, viewportHeight: number): LodStep {
    if (this.screenErrorForStep(2, distance, camera, viewportHeight) > SSE_TARGET_PX) return 1;
    if (this.screenErrorForStep(4, distance, camera, viewportHeight) > SSE_TARGET_PX) return 2;
    if (this.screenErrorForStep(8, distance, camera, viewportHeight) > SSE_TARGET_PX) return 4;
    return 8;
  }

  private currentStep(e: ChunkSchedulerEntry | undefined): LodStep | null {
    if (!e || e.displayed === 'none') return null;
    if (e.displayed === 'full') return 1;
    return (LOD_STEPS.includes(e.displayedLodStep as LodStep) ? e.displayedLodStep : 8) as LodStep;
  }

  private selectLodStep(
    distance: number,
    camera: ChunkSchedulerCamera,
    viewportHeight: number,
    e: ChunkSchedulerEntry | undefined,
    currentCheb: number,
    predictedFrustum: boolean,
    movingFast: boolean,
  ): LodStep {
    if (this.lodDisabled()) return 1;
    if (!predictedFrustum && currentCheb <= this.fullRadius()) return 1;
    if (!predictedFrustum && e?.displayed === 'full' && currentCheb <= this.fullRadius() + FULL_HOLD_MARGIN_CHUNKS) return 1;
    const base = Math.max(2, this.baseLodStep(distance, camera, viewportHeight)) as LodStep;
    const current = this.currentStep(e);
    if (!current || current === 1 || e?.dirty) return movingFast ? Math.max(base, 4) as LodStep : base;
    if (base > current) {
      return this.screenErrorForStep(base, distance, camera, viewportHeight) < SSE_COARSEN_PX ? base : current;
    }
    if (base < current) {
      return this.screenErrorForStep(current, distance, camera, viewportHeight) > SSE_REFINE_PX ? base : current;
    }
    return base;
  }

  private tierForCandidate(
    e: ChunkSchedulerEntry | undefined,
    targetStep: LodStep,
    currentFrustum: boolean,
    predictedFrustum: boolean,
    forcedFull: boolean,
  ): number {
    const displayedStep = this.currentStep(e);
    const empty = !e || e.displayed === 'none';
    if (forcedFull && empty) return 0;
    if (forcedFull && e?.displayed !== 'full') return 1;
    if (currentFrustum && empty) return 2;
    if (currentFrustum && (!displayedStep || targetStep < displayedStep || e?.dirty || targetStep === 1)) return 3;
    if (predictedFrustum) return 4;
    return 5;
  }

  private updateFrameLoadStats(
    candidates: ChunkCandidate[],
    entryFor: (key: string) => ChunkSchedulerEntry | null,
  ) {
    let currentFrustumTotal = 0;
    let currentFrustumLoaded = 0;
    let hasMoreCurrentFrustumChunks = false;
    for (const candidate of candidates) {
      if (!candidate.currentFrustum) continue;
      currentFrustumTotal++;
      const entry = entryFor(candidate.key);
      if (this.ioComplete(entry)) {
        currentFrustumLoaded++;
      } else if (this.mayLoadChunk(entry)) {
        hasMoreCurrentFrustumChunks = true;
      }
    }
    this.frameLoadStats = { currentFrustumTotal, currentFrustumLoaded, hasMoreCurrentFrustumChunks };
  }

  private ioComplete(e: ChunkSchedulerEntry | null): boolean {
    return !!e && (e.state === 'decoding' || e.state === 'stored' || e.state === 'absent' || e.state === 'error');
  }

  private mayLoadChunk(e: ChunkSchedulerEntry | null): boolean {
    return !e || e.state === 'checking' || e.state === 'hashed' || e.state === 'fetching';
  }

  // #endregion

  // #region Mesh priority

  private rememberRecord(candidate: ChunkCandidate, e?: ChunkSchedulerEntry): SchedulerRecord {
    const existing = this.recordByKey.get(candidate.key);
    const stabilized = this.stabilizeTargetStep(candidate, existing, e);
    candidate.targetStep = stabilized.lastTargetStep;
    const record: SchedulerRecord = {
      key: candidate.key,
      cx: candidate.cx,
      cz: candidate.cz,
      lastWantedAt: candidate.updatedAt,
      lastTier: candidate.tier,
      lastScore: candidate.score,
      lastTargetStep: stabilized.lastTargetStep,
      lastForcedFull: candidate.forcedFull,
      stableTargetStep: stabilized.stableTargetStep,
      pendingTargetStep: stabilized.pendingTargetStep,
      targetChangedAt: stabilized.targetChangedAt,
      lastRefineAt: stabilized.lastRefineAt,
      lastCoarsenAt: stabilized.lastCoarsenAt,
    };
    this.recordByKey.set(candidate.key, record);
    this.rememberPriority(candidate.key, candidate);
    return record;
  }

  private stabilizeTargetStep(
    candidate: ChunkCandidate,
    existing: SchedulerRecord | undefined,
    e?: ChunkSchedulerEntry,
  ): StableTargetState {
    const raw = candidate.targetStep;
    if (!existing || !e || e.displayed === 'none' || e.dirty) {
      return {
        lastTargetStep: raw,
        stableTargetStep: raw,
        pendingTargetStep: raw,
        targetChangedAt: candidate.updatedAt,
        lastRefineAt: raw < (existing?.stableTargetStep ?? raw) ? candidate.updatedAt : existing?.lastRefineAt ?? 0,
        lastCoarsenAt: raw > (existing?.stableTargetStep ?? raw) ? candidate.updatedAt : existing?.lastCoarsenAt ?? 0,
      };
    }

    let stable = existing.stableTargetStep ?? existing.lastTargetStep;
    let pending = existing.pendingTargetStep ?? stable;
    let changedAt = existing.targetChangedAt || candidate.updatedAt;
    let lastRefineAt = existing.lastRefineAt || 0;
    let lastCoarsenAt = existing.lastCoarsenAt || 0;

    if (raw === stable) {
      pending = raw;
      changedAt = candidate.updatedAt;
    } else {
      if (pending !== raw) {
        pending = raw;
        changedAt = candidate.updatedAt;
      }
      const tuning = this.tuning();
      const refining = raw < stable;
      const minStableMs = refining ? tuning.refineStabilityMs : tuning.coarsenStabilityMs;
      const recentlyRefined = !refining && lastRefineAt > 0 && candidate.updatedAt - lastRefineAt < tuning.coarsenStabilityMs;
      if (!recentlyRefined && candidate.updatedAt - changedAt >= minStableMs) {
        const previous = stable;
        stable = raw;
        if (stable < previous) lastRefineAt = candidate.updatedAt;
        else if (stable > previous) lastCoarsenAt = candidate.updatedAt;
        pending = stable;
        changedAt = candidate.updatedAt;
      }
    }

    return {
      lastTargetStep: stable,
      stableTargetStep: stable,
      pendingTargetStep: pending,
      targetChangedAt: changedAt,
      lastRefineAt,
      lastCoarsenAt,
    };
  }

  private recordFor(e: ChunkSchedulerEntry): SchedulerRecord | null {
    const record = this.recordByKey.get(e.key);
    if (record) return record;
    if (Number.isFinite(e.lastWantedAt)) {
      return {
        key: e.key,
        cx: e.cx,
        cz: e.cz,
        lastWantedAt: e.lastWantedAt,
        lastTier: e.lastTier,
        lastScore: e.lastScore,
        lastTargetStep: e.lastTargetStep,
        lastForcedFull: e.lastForcedFull,
        stableTargetStep: e.lastTargetStep,
        pendingTargetStep: e.lastTargetStep,
        targetChangedAt: e.lastWantedAt,
        lastRefineAt: 0,
        lastCoarsenAt: 0,
      };
    }
    return null;
  }

  private lastWantedAt(e: ChunkSchedulerEntry): number {
    return this.recordFor(e)?.lastWantedAt ?? 0;
  }

  private lastTier(e: ChunkSchedulerEntry): number {
    return this.recordFor(e)?.lastTier ?? 99;
  }

  private lastScore(e: ChunkSchedulerEntry): number {
    return this.recordFor(e)?.lastScore ?? Infinity;
  }

  private lastTargetStep(e: ChunkSchedulerEntry): LodStep {
    if (this.lodDisabled()) return 1;
    return this.recordFor(e)?.lastTargetStep ?? 8;
  }

  private rememberPriority(key: string, priority: ChunkPriority) {
    this.priorityByKey.set(key, { tier: priority.tier, score: priority.score, updatedAt: priority.updatedAt });
    if (this.hashQueue.has(key)) this.pushIoQueueNode('hash', key);
    if (this.fetchQueue.has(key)) this.pushIoQueueNode('fetch', key);
    for (const [queueKey, task] of this.meshQueue) {
      if (task.key === key) this.pushMeshQueueNode(queueKey);
    }
  }

  private desiredMeshTasks(e: ChunkSchedulerEntry, targetStep: LodStep, priority: ChunkPriority): MeshTask[] {
    const tasks: MeshTask[] = [];
    if (this.lodDisabled()) {
      if (this.wantsFull(e)) tasks.push({ key: e.key, kind: 'full', step: 1, ...priority, tier: Math.min(priority.tier, e.displayed === 'none' ? 0 : priority.tier) });
      return tasks;
    }
    if (e.displayed === 'none') {
      const tuning = this.tuning();
      const previewStep = this.previewStepFor(targetStep);
      if (previewStep === 1) {
        if (this.wantsFull(e)) {
          tasks.push({
            key: e.key,
            kind: 'full',
            step: 1,
            tier: Math.min(priority.tier, 1),
            score: priority.score - FORCED_FULL_SCORE_BONUS * Math.max(0.25, tuning.refinementBias),
            updatedAt: priority.updatedAt,
          });
        }
      } else if (this.wantsLod(e, previewStep)) {
        tasks.push({
          key: e.key,
          kind: 'lod',
          step: previewStep,
          tier: Math.min(priority.tier, targetStep === 1 ? 0 : 2),
          score: priority.score - EMPTY_COVERAGE_SCORE_BONUS * 0.25 * tuning.previewBias,
          updatedAt: priority.updatedAt,
        });
      }
      return tasks;
    }

    if (targetStep === 1) {
      if (this.wantsFull(e)) {
        tasks.push({ key: e.key, kind: 'full', step: 1, ...priority });
      }
      return tasks;
    }
    if (this.wantsLod(e, targetStep)) tasks.push({ key: e.key, kind: 'lod', step: targetStep, ...priority });
    return tasks;
  }

  private previewStepFor(targetStep: LodStep): LodStep {
    if (this.lodDisabled()) return 1;
    const tuning = this.tuning();
    if (tuning.previewBias <= 0) return targetStep;
    if (targetStep === 1) return tuning.fullPreviewLodStep;
    if (targetStep <= 2) return tuning.lodPreviewStep;
    return targetStep;
  }

  private enqueueDesiredMeshTask(
    key: string,
    e: ChunkSchedulerEntry,
    targetStep: LodStep,
    priority: ChunkPriority,
  ) {
    for (const task of this.desiredMeshTasks(e, targetStep, priority)) this.enqueueMeshTask({ ...task, key });
  }

  private wantsFull(e: ChunkSchedulerEntry): boolean {
    return !e.pendingFull && (e.displayed !== 'full' || e.dirty);
  }

  private wantsLod(e: ChunkSchedulerEntry, step: LodStep): boolean {
    if (this.lodDisabled()) return false;
    const displayedSameLod = e.displayed === 'lod' && e.displayedLodStep === step;
    if (displayedSameLod && !e.dirty) return false;
    if (!e.pendingLod) return true;
    if (!e.dirty && e.pendingLodStep > 0 && e.pendingLodStep <= step) return false;
    return e.pendingLodStep !== step;
  }

  private displaySatisfiesTarget(e: ChunkSchedulerEntry, targetStep: LodStep): boolean {
    if (e.dirty) return false;
    if (targetStep === 1) return e.displayed === 'full';
    if (e.displayed === 'full') return true;
    if (e.displayed !== 'lod' || e.displayedLodStep <= 0) return false;
    return e.displayedLodStep <= targetStep;
  }

  private comparePriority(a: ChunkPriority, b: ChunkPriority): number {
    const priorityTier = a.tier - b.tier;
    if (priorityTier !== 0) return priorityTier;
    const aScore = this.ageAdjustedScore(a);
    const bScore = this.ageAdjustedScore(b);
    return aScore - bScore || a.updatedAt - b.updatedAt;
  }

  private ageAdjustedScore(priority: ChunkPriority): number {
    return priority.score + priority.updatedAt * IO_AGING_SCORE_PER_MS;
  }

  private compareMeshTasks(a: MeshTask, b: MeshTask, fullBias: boolean): number {
    if (fullBias && a.kind !== b.kind) return a.kind === 'full' ? -1 : 1;
    const tier = a.tier - b.tier;
    if (tier !== 0) return tier;
    const aScore = this.meshTaskPriorityScore(a);
    const bScore = this.meshTaskPriorityScore(b);
    if (aScore !== bScore) return aScore - bScore;
    if (a.kind !== b.kind) return a.kind === 'lod' ? -1 : 1;
    return a.step - b.step;
  }

  private meshTaskPriorityScore(task: MeshTask): number {
    const tuning = this.tuning();
    const previewBias = task.kind === 'lod' ? -12 * (tuning.previewBias - 1) : 0;
    const refinementBias = task.kind === 'full' ? -24 * (tuning.refinementBias - 1) : 0;
    return this.ageAdjustedScore(task) + this.estimateMeshTaskCost(task) * MESH_COST_SCORE_WEIGHT + previewBias + refinementBias;
  }

  private withLatestPriority(task: MeshTask): MeshTask {
    const latest = this.priorityByKey.get(task.key);
    if (!latest) return task;
    return { ...task, tier: Math.min(task.tier, latest.tier), score: Math.min(task.score, latest.score), updatedAt: latest.updatedAt };
  }

  private estimateCandidateCost(e: ChunkSchedulerEntry | undefined, targetStep: LodStep): number {
    let cost = 0;
    if (!e || e.state === 'checking') cost += this.estimatedHashCost() + this.estimatedFetchCost();
    else if (e.state === 'hashed' || e.state === 'fetching') cost += this.estimatedFetchCost();
    if (!e || e.state !== 'stored') return cost;
    if (this.lodDisabled()) {
      cost += this.estimateMeshTaskCost({ kind: 'full', step: 1 });
      return cost;
    }
    if (e.displayed === 'none') cost += this.estimateMeshTaskCost({ kind: 'lod', step: this.previewStepFor(targetStep) });
    else if (targetStep === 1) cost += this.estimateMeshTaskCost({ kind: 'full', step: 1 });
    else cost += this.estimateMeshTaskCost({ kind: 'lod', step: targetStep });
    return cost;
  }

  private estimatedHashCost(): number {
    return Math.max(40, this.profileStats.hashFetchMsAvg || 450);
  }

  private estimatedFetchCost(): number {
    return Math.max(80, this.profileStats.chunkFetchMsAvg || 900);
  }

  private estimateMeshTaskCost(task: Pick<MeshTask, 'kind' | 'step'>): number {
    if (task.kind === 'full') return Math.max(80, this.profileStats.fullMeshMsAvg || 180);
    const base = Math.max(50, this.profileStats.lodMeshMsAvg || 120);
    const stepFactor = task.step <= 2 ? 1 : task.step === 4 ? 0.72 : 0.55;
    return base * stepFactor;
  }

  private shouldStartMeshTask(task: MeshTask, e: ChunkSchedulerEntry, now: number): boolean {
    if (!this.priorityFresh(e, now)) return false;
    if (this.lodDisabled() && task.kind !== 'full') return false;
    if (task.kind === 'full') {
      return this.lastTargetStep(e) === 1 && this.wantsFull(e);
    }
    if (!this.wantsLod(e, task.step)) return false;
    const targetStep = this.lastTargetStep(e);
    if (targetStep === 1) return e.displayed === 'none';
    if (task.step > targetStep && e.displayed !== 'none') return false;
    if (e.displayed === 'full' && this.lastTier(e) <= 3 && !e.dirty) return false;
    return true;
  }

  private meshStartBudget(entries: Iterable<ChunkSchedulerEntry>, activeMeshTasks: number, maxMeshTasks: number): MeshStartBudget {
    const slots = Math.max(0, maxMeshTasks - activeMeshTasks);
    if (this.lodDisabled()) return { fullRemaining: slots, lodCoverageBacklog: 0 };
    const tuning = this.tuning();
    const lodCoverageBacklog = this.lodCoverageBacklog(entries);
    const fullBias = this.shouldBiasFull(entries);
    const fullRemaining = lodCoverageBacklog >= tuning.coverageBacklogForFullThrottle && !fullBias
      ? Math.max(0, Math.floor(slots * tuning.fullTaskQuotaShare))
      : slots;
    return { fullRemaining, lodCoverageBacklog };
  }

  private lodCoverageBacklog(entries: Iterable<ChunkSchedulerEntry>): number {
    if (this.lodDisabled()) return 0;
    let out = 0;
    for (const e of entries) {
      if (e.state !== 'stored' || e.displayed !== 'none') continue;
      if (this.lastTier(e) > 4) continue;
      if (!e.pendingLod) out++;
    }
    return out;
  }

  private meshTaskWithinBudget(task: MeshTask, e: ChunkSchedulerEntry, budget: MeshStartBudget): boolean {
    if (this.lodDisabled()) return task.kind === 'full' && budget.fullRemaining > 0;
    if (task.kind === 'lod' && e.displayed === 'none') return true;
    if (task.kind === 'full') return budget.fullRemaining > 0;
    return budget.lodCoverageBacklog <= 0 || task.tier <= 2;
  }

  private consumeMeshBudget(task: MeshTask, e: ChunkSchedulerEntry, budget: MeshStartBudget) {
    if (task.kind === 'full') budget.fullRemaining = Math.max(0, budget.fullRemaining - 1);
    else if (e.displayed === 'none') budget.lodCoverageBacklog = Math.max(0, budget.lodCoverageBacklog - 1);
  }

  // #endregion

  // #region Backpressure

  private renderBacklog(entries: Iterable<ChunkSchedulerEntry>, activeMeshTasks: number): number {
    let waitingStored = 0;
    for (const e of entries) {
      if (e.state !== 'stored' || this.lastTier(e) > 4) continue;
      if (e.displayed === 'none' || e.dirty || e.pendingFull || e.pendingLod) waitingStored++;
    }
    return this.meshQueue.size + activeMeshTasks + waitingStored;
  }

  private loadBacklog(activeIoBatches: number): number {
    return this.hashQueue.size + this.fetchQueue.size + activeIoBatches;
  }

  private shouldLoadMore(activeIoBatches: number, renderWork: number): boolean {
    const loadWork = this.loadBacklog(activeIoBatches);
    if (loadWork <= 0) return false;
    if (this.shouldPrioritizeInitialLoad()) return true;
    if (this.renderStats.nbt <= 0) return false;
    if (
      this.activeStrategy.mode === 'topDown'
      && this.frameLoadStats.hasMoreCurrentFrustumChunks
      && (
        this.currentFrustumLoadShare() < 0.25
        || renderWork <= this.activeLimits().maxMeshQueue
        || this.readyShare() >= 0.35
      )
    ) {
      return true;
    }
    const readyTarget = this.currentFrustumLoaded() ? OUTER_IO_RENDER_SHARE_TARGET : IO_RENDER_SHARE_TARGET;
    return this.readyShare() >= readyTarget || (this.currentFrustumLoaded() && renderWork <= 12);
  }

  private nextLimitedIoBatch(
    queue: Set<string>,
    opts: {
      activeBatches: number;
      maxBatches: number;
      batchSize: number;
      busyBatchFloor: number;
      entries: Iterable<ChunkSchedulerEntry>;
      activeMeshTasks: number;
    },
  ): string[] {
    if (opts.activeBatches >= opts.maxBatches) return [];
    const renderWork = this.renderBacklog(opts.entries, opts.activeMeshTasks);
    const prioritizeLoad = this.shouldPrioritizeInitialLoad();
    if (!this.shouldLoadMore(opts.activeBatches, renderWork)) {
      debugLog('scheduler', 'io-paused', {
        mode: this.activeStrategy.mode,
        queue: queue.size,
        activeBatches: opts.activeBatches,
        renderWork,
        currentFrustumLoadShare: this.currentFrustumLoadShare(),
        readyShare: this.readyShare(),
        renderStats: this.renderStats,
        frameLoadStats: this.frameLoadStats,
      });
      return [];
    }
    const limits = this.activeLimits();
    const baseBatchSize = prioritizeLoad || renderWork <= 0
      ? opts.batchSize
      : Math.max(opts.busyBatchFloor, Math.floor(opts.batchSize / 2));
    const batchSize = this.priorityByKey.size > limits.softTrackedChunks && !prioritizeLoad
      ? Math.max(opts.busyBatchFloor, Math.floor(baseBatchSize / 2))
      : baseBatchSize;
    const maxTier = renderWork > 0 ? 4 : 99;
    const batch = this.nextIoBatch(queue, batchSize, maxTier);
    debugLog('scheduler', 'io-batch', {
      mode: this.activeStrategy.mode,
      count: batch.length,
      batchSize,
      maxTier,
      queueRemaining: queue.size,
      renderWork,
      readyShare: this.readyShare(),
    });
    return batch;
  }

  private currentFrustumLoaded(): boolean {
    const { currentFrustumTotal, currentFrustumLoaded } = this.frameLoadStats;
    return currentFrustumTotal <= 0 || currentFrustumLoaded >= currentFrustumTotal;
  }

  private currentFrustumLoadShare(): number {
    const { currentFrustumTotal, currentFrustumLoaded } = this.frameLoadStats;
    return currentFrustumTotal <= 0 ? 1 : currentFrustumLoaded / currentFrustumTotal;
  }

  private shouldPrioritizeInitialLoad(): boolean {
    return this.renderStats.nbt < MIN_EXISTING_CHUNKS_BEFORE_BALANCE
      && this.frameLoadStats.hasMoreCurrentFrustumChunks;
  }

  private readyShare(): number {
    if (this.renderStats.nbt <= 0) return 0;
    return (this.renderStats.lodReady + this.renderStats.fullReady) / this.renderStats.nbt;
  }

  private shouldBiasFull(entries: Iterable<ChunkSchedulerEntry>): boolean {
    if (this.lodDisabled()) return true;
    let nFull = 0;
    let nLod = 0;
    for (const e of entries) {
      if (e.displayed === 'full') nFull++;
      else if (e.displayed === 'lod') nLod++;
    }
    if (nLod < 12) return false;
    const sf = Math.sqrt(nFull);
    const sl = Math.sqrt(nLod);
    const share = sf / Math.max(1, sf + sl);
    return share < this.tuning().minFullLodShare;
  }

  // #endregion

  // #region Queue ordering and limits

  private nextIoBatch(queue: Set<string>, batchSize: number, maxTier: number): string[] {
    const kind = queue === this.hashQueue ? 'hash' : 'fetch';
    const heap = kind === 'hash' ? this.hashQueueHeap : this.fetchQueueHeap;
    const out: string[] = [];
    while (out.length < batchSize && queue.size > 0) {
      const node = heap.pop();
      if (!node) this.rebuildIoQueueHeap(kind);
      const current = node ?? heap.pop();
      if (!current) break;
      if (!this.validIoQueueNode(kind, current)) continue;
      const priority = this.priorityByKey.get(current.key) ?? { tier: 99, score: Infinity, updatedAt: 0 };
      if (priority.tier > maxTier) {
        heap.push(current);
        break;
      }
      queue.delete(current.key);
      if (kind === 'hash') this.hashQueueSeq.delete(current.key);
      else this.fetchQueueSeq.delete(current.key);
      out.push(current.key);
    }
    return out;
  }

  private sortKeys(keys: Iterable<string>): string[] {
    return [...keys].sort((a, b) => this.compareQueuedKeys(a, b));
  }

  private trimIoQueue(kind: 'hash' | 'fetch') {
    const queue = kind === 'hash' ? this.hashQueue : this.fetchQueue;
    const limit = this.activeLimits().maxIoQueue;
    if (queue.size <= limit) return;
    const sorted = this.sortKeys(queue).slice(0, limit);
    const now = performance.now();
    if (now - this.lastIoTrimLogAt[kind] > 500) {
      this.lastIoTrimLogAt[kind] = now;
      debugLog('scheduler', 'trim-io-queue', { kind, before: queue.size, after: sorted.length, limit });
    }
    if (kind === 'hash') {
      this.hashQueue = new Set(sorted);
      this.hashQueueSeq.clear();
    } else {
      this.fetchQueue = new Set(sorted);
      this.fetchQueueSeq.clear();
    }
    for (const key of sorted) this.pushIoQueueNode(kind, key);
  }

  private trimMeshQueue() {
    const limit = this.activeLimits().maxMeshQueue;
    if (this.meshQueue.size <= limit) return;
    const sorted = [...this.meshQueue.entries()].sort((a, b) => this.compareMeshTasks(a[1], b[1], false));
    const now = performance.now();
    if (now - this.lastMeshTrimLogAt > 500) {
      this.lastMeshTrimLogAt = now;
      debugLog('scheduler', 'trim-mesh-queue', { before: this.meshQueue.size, after: Math.min(sorted.length, limit), limit });
    }
    this.meshQueue = new Map(sorted.slice(0, limit));
    this.meshQueueSeq.clear();
    this.meshQueueHeap.clear();
    for (const queueKey of this.meshQueue.keys()) this.pushMeshQueueNode(queueKey);
  }

  private pushIoQueueNode(kind: 'hash' | 'fetch', key: string) {
    const seq = ++this.queueSeqCounter;
    if (kind === 'hash') {
      this.hashQueueSeq.set(key, seq);
      this.hashQueueHeap.push({ key, seq });
    } else {
      this.fetchQueueSeq.set(key, seq);
      this.fetchQueueHeap.push({ key, seq });
    }
  }

  private validIoQueueNode(kind: 'hash' | 'fetch', node: IoQueueNode): boolean {
    const queue = kind === 'hash' ? this.hashQueue : this.fetchQueue;
    const seq = kind === 'hash' ? this.hashQueueSeq.get(node.key) : this.fetchQueueSeq.get(node.key);
    return queue.has(node.key) && seq === node.seq;
  }

  private rebuildIoQueueHeap(kind: 'hash' | 'fetch') {
    const queue = kind === 'hash' ? this.hashQueue : this.fetchQueue;
    const nodes: IoQueueNode[] = [];
    for (const key of queue) {
      const seq = ++this.queueSeqCounter;
      if (kind === 'hash') this.hashQueueSeq.set(key, seq);
      else this.fetchQueueSeq.set(key, seq);
      nodes.push({ key, seq });
    }
    if (kind === 'hash') this.hashQueueHeap.rebuild(nodes);
    else this.fetchQueueHeap.rebuild(nodes);
  }

  private compareQueuedKeys(a: string, b: string): number {
    const ap = this.priorityByKey.get(a) ?? { tier: 99, score: Infinity, updatedAt: 0 };
    const bp = this.priorityByKey.get(b) ?? { tier: 99, score: Infinity, updatedAt: 0 };
    return this.comparePriority(ap, bp) || a.localeCompare(b);
  }

  private pushMeshQueueNode(queueKey: string) {
    if (!this.meshQueue.has(queueKey)) return;
    const seq = ++this.queueSeqCounter;
    this.meshQueueSeq.set(queueKey, seq);
    this.meshQueueHeap.push({ queueKey, seq });
  }

  private validMeshQueueNode(node: MeshQueueNode): boolean {
    return this.meshQueue.has(node.queueKey) && this.meshQueueSeq.get(node.queueKey) === node.seq;
  }

  private currentMeshTask(queueKey: string): MeshTask | null {
    const task = this.meshQueue.get(queueKey);
    return task ? this.withLatestPriority(task) : null;
  }

  private removeMeshQueueKey(queueKey: string) {
    this.meshQueue.delete(queueKey);
    this.meshQueueSeq.delete(queueKey);
  }

  private rebuildMeshQueueHeapAndPop(): MeshQueueNode | undefined {
    const nodes: MeshQueueNode[] = [];
    for (const queueKey of this.meshQueue.keys()) {
      const seq = ++this.queueSeqCounter;
      this.meshQueueSeq.set(queueKey, seq);
      nodes.push({ queueKey, seq });
    }
    this.meshQueueHeap.rebuild(nodes);
    return this.meshQueueHeap.pop();
  }

  private compareQueuedMeshNodes(a: MeshQueueNode, b: MeshQueueNode): number {
    const at = this.currentMeshTask(a.queueKey);
    const bt = this.currentMeshTask(b.queueKey);
    if (!at && !bt) return 0;
    if (!at) return 1;
    if (!bt) return -1;
    return this.compareMeshTasks(at, bt, false) || a.queueKey.localeCompare(b.queueKey);
  }

  private meshQueueKey(task: Pick<MeshTask, 'key' | 'kind'>): string {
    return `${task.key}\u0000${task.kind}`;
  }


  private activeLimits(): SchedulerLimits {
    return this.activeStrategy.limits(this.opts);
  }

  // #endregion
}
