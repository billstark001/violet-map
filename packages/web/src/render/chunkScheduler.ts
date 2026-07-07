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

export const LOD_STEPS = [1, 2, 4, 8] as const;
export type LodStep = typeof LOD_STEPS[number];
export type MeshTaskKind = 'full' | 'lod';
export type ChunkSchedulerCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;
export type ChunkSchedulerViewMode = 'perspective' | 'topDown';

export interface ChunkSchedulerOptions {
  viewDistance: number;
  lodDistance: number;
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

export interface SchedulerFramePlan {
  candidates: ChunkCandidate[];
  keepKeys: Set<string>;
  centerCx: number;
  centerCz: number;
}

export interface SchedulerCandidateDecision {
  removeMesh: boolean;
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

function fullRadiusForOptions(opts: ChunkSchedulerOptions): number {
  return Math.max(0, Math.floor(opts.viewDistance));
}

function totalRenderRadiusForOptions(opts: ChunkSchedulerOptions): number {
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
    const offlineBacked = Math.max(0, Math.floor(opts.lodDistance)) === 0;
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
  private priorityByKey = new Map<string, ChunkPriority>();
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
  private readonly perspectiveStrategy = new PerspectiveChunkSchedulingStrategy();
  private readonly topDownStrategy = new TopDownChunkSchedulingStrategy();
  private activeStrategy: ChunkSchedulingStrategy = this.perspectiveStrategy;
  private lastMeshTrimLogAt = 0;
  private lastIoTrimLogAt: Record<'hash' | 'fetch', number> = { hash: 0, fetch: 0 };

  // #region Lifecycle and options

  constructor(private opts: ChunkSchedulerOptions) {}

  setOptions(opts: ChunkSchedulerOptions) {
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
    this.priorityByKey.clear();
  }

  // #endregion

  // #region Frame planning

  planFrame(
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

  scheduleCandidate(candidate: ChunkCandidate, e: ChunkSchedulerEntry): SchedulerCandidateDecision {
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

  scheduleStoredFromLastPriority(e: ChunkSchedulerEntry, now: number) {
    if (e.state !== 'stored' || now - e.lastWantedAt > IO_QUEUE_RETENTION_MS) return;
    const priority = this.priorityByKey.get(e.key) ?? { tier: e.lastTier, score: e.lastScore, updatedAt: e.lastWantedAt };
    this.enqueueDesiredMeshTask(e.key, e, e.lastTargetStep, priority);
  }

  nextMeshTask(entryFor: (key: string) => ChunkSchedulerEntry | null, entries: Iterable<ChunkSchedulerEntry>, now: number): MeshTask | null {
    const fullBias = this.shouldBiasFull(entries);
    while (this.meshQueue.size > 0) {
      let best: MeshTask | null = null;
      let bestQueueKey: string | null = null;
      for (const [queueKey, task] of this.meshQueue) {
        const latest = this.priorityByKey.get(task.key);
        const effective = latest ? { ...task, score: latest.score, updatedAt: latest.updatedAt } : task;
        if (!best || this.compareMeshTasks(effective, best, fullBias) < 0) {
          best = effective;
          bestQueueKey = queueKey;
        }
      }
      if (!best) return null;
      if (bestQueueKey) this.meshQueue.delete(bestQueueKey);
      const e = entryFor(best.key);
      if (!e || e.state !== 'stored') continue;
      if (!this.shouldStartMeshTask(best, e, now)) continue;
      return best;
    }
    return null;
  }

  priorityFor(key: string, fallback: ChunkPriority): ChunkPriority {
    return this.priorityByKey.get(key) ?? fallback;
  }

  priorityFresh(e: ChunkSchedulerEntry, now: number, maxAge = IO_QUEUE_RETENTION_MS): boolean {
    return now - e.lastWantedAt <= maxAge;
  }

  shouldApplyFullResult(e: ChunkSchedulerEntry, _version: number, now: number): boolean {
    if (!this.priorityFresh(e, now)) return false;
    return e.lastTargetStep === 1;
  }

  shouldApplyLodResult(e: ChunkSchedulerEntry, step: LodStep, version: number, now: number): boolean {
    if (version < e.displayedVersion || !this.priorityFresh(e, now)) return false;
    if (e.lastTargetStep === 1) return e.displayed === 'none';
    if (step > e.lastTargetStep && e.displayed !== 'none') return false;
    if (e.displayed === 'full' && e.lastTier <= 3 && !e.dirty) return false;
    return true;
  }

  // #endregion

  // #region Queue operations

  nextHashBatch(activeBatches: number, entries: Iterable<ChunkSchedulerEntry>, activeMeshTasks: number): string[] {
    return this.nextLimitedIoBatch(this.hashQueue, {
      activeBatches,
      maxBatches: MAX_HASH_BATCHES,
      batchSize: HASH_BATCH_SIZE,
      busyBatchFloor: 12,
      entries,
      activeMeshTasks,
    });
  }

  nextFetchBatch(activeBatches: number, entries: Iterable<ChunkSchedulerEntry>, activeMeshTasks: number): string[] {
    return this.nextLimitedIoBatch(this.fetchQueue, {
      activeBatches,
      maxBatches: MAX_FETCH_BATCHES,
      batchSize: FETCH_BATCH_SIZE,
      busyBatchFloor: 8,
      entries,
      activeMeshTasks,
    });
  }

  pruneQueues(keepKeys: Set<string>, now: number) {
    const keepIo = (key: string) => {
      const priority = this.priorityByKey.get(key);
      return keepKeys.has(key) || (!!priority && now - priority.updatedAt < IO_QUEUE_RETENTION_MS);
    };
    for (const key of this.hashQueue) if (!keepIo(key)) this.hashQueue.delete(key);
    for (const key of this.fetchQueue) if (!keepIo(key)) this.fetchQueue.delete(key);
    for (const [queueKey, task] of this.meshQueue) if (!keepKeys.has(task.key)) this.meshQueue.delete(queueKey);
    this.trimIoQueue('hash');
    this.trimIoQueue('fetch');
    this.trimMeshQueue();
  }

  expirePriorities(now: number) {
    for (const [key, priority] of this.priorityByKey) {
      if (now - priority.updatedAt > IO_QUEUE_RETENTION_MS) this.priorityByKey.delete(key);
    }
  }

  evictKeys(ccx: number, ccz: number, keepKeys: Set<string>, entries: Iterable<ChunkSchedulerEntry>, now: number): string[] {
    const out: string[] = [];
    const limits = this.activeLimits();
    const unloadDistance = limits.unloadDistanceChunks;
    const all = [...entries];
    for (const e of all) {
      const d = this.activeStrategy.circularEviction
        ? Math.hypot(e.cx - ccx, e.cz - ccz)
        : Math.max(Math.abs(e.cx - ccx), Math.abs(e.cz - ccz));
      if (!keepKeys.has(e.key) && d > unloadDistance) out.push(e.key);
    }

    if (all.length - out.length <= limits.softTrackedChunks) return out;
    const already = new Set(out);
    const victims = all
      .filter((e) => !keepKeys.has(e.key) && !already.has(e.key))
      .sort((a, b) => a.lastWantedAt - b.lastWantedAt || b.lastScore - a.lastScore);
    let tracked = all.length - out.length;
    for (const e of victims) {
      if (tracked <= limits.softTrackedChunks) break;
      if (tracked <= limits.hardTrackedChunks && now - e.lastWantedAt < 1000) continue;
      out.push(e.key);
      tracked--;
    }
    if (out.length) {
      debugLog('scheduler', 'evict', {
        mode: this.activeStrategy.mode,
        evicted: out.length,
        trackedBefore: all.length,
        trackedAfter: all.length - out.length,
        softTrackedChunks: limits.softTrackedChunks,
        hardTrackedChunks: limits.hardTrackedChunks,
      });
    }
    return out;
  }

  enqueueHash(key: string) {
    this.hashQueue.add(key);
  }

  enqueueFetch(key: string) {
    this.fetchQueue.add(key);
  }

  enqueueMeshTask(task: MeshTask) {
    const queueKey = this.meshQueueKey(task);
    const existing = this.meshQueue.get(queueKey);
    if (existing && this.compareMeshTasks(existing, task, false) <= 0) return;
    this.meshQueue.set(queueKey, task);
    this.trimMeshQueue();
  }

  deleteKey(key: string) {
    this.hashQueue.delete(key);
    this.fetchQueue.delete(key);
    for (const [queueKey, task] of this.meshQueue) {
      if (task.key === key) this.meshQueue.delete(queueKey);
    }
    this.priorityByKey.delete(key);
  }

  get hasHashWork() { return this.hashQueue.size > 0; }
  get hasFetchWork() { return this.fetchQueue.size > 0; }

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
    const scanRadius = total + (
      topDownView && this.totalRenderRadius() === this.fullRadius()
        ? TOP_DOWN_OFFLINE_PREDICT_MARGIN_CHUNKS
        : PREDICT_MARGIN_CHUNKS
    );
    const movingFast = this.cameraVelocity.length() > FAST_MOVE_BLOCKS_PER_SECOND;
    const minCx = Math.min(ccx, pcx) - scanRadius;
    const maxCx = Math.max(ccx, pcx) + scanRadius;
    const minCz = Math.min(ccz, pcz) - scanRadius;
    const maxCz = Math.max(ccz, pcz) + scanRadius;
    const topBounds = topDownView ? this.topDownBounds(camera) : null;
    const out: ChunkCandidate[] = [];

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const currentRadius = topDownView
          ? this.chunkDistanceInChunks(camera.position, cx, cz)
          : Math.max(Math.abs(cx - ccx), Math.abs(cz - ccz));
        const predictedRadius = topDownView
          ? this.chunkDistanceInChunks(this.predictedCameraPosition, cx, cz)
          : Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz));
        const forcedFull = currentRadius <= fullRadius;
        if (!forcedFull && currentRadius > total && predictedRadius > total + PREDICT_MARGIN_CHUNKS) continue;

        const currentFrustum = topDownView
          ? currentRadius <= total && (forcedFull || this.chunkIntersectsTopDownBounds(topBounds, cx, cz))
          : currentRadius <= total && (forcedFull || this.chunkIntersectsFrustum(this.currentFrustum, cx, cz));
        const predictedFrustum = !currentFrustum
          && predictedRadius <= total + PREDICT_MARGIN_CHUNKS
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
        const score = (currentFrustum || forcedFull ? distCurrent : distPredicted) - this.screenErrorForStep(targetStep, sseDistance, camera, viewportHeight) * 8;
        out.push({ key, cx, cz, targetStep, currentFrustum, predictedFrustum, forcedFull, tier, score, updatedAt: now });
      }
    }

    out.sort((a, b) => a.tier - b.tier || a.score - b.score);
    return this.limitCandidates(out);
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

  private fullRadius(): number {
    return fullRadiusForOptions(this.opts);
  }

  private totalRenderRadius(): number {
    return totalRenderRadiusForOptions(this.opts);
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

  private rememberPriority(key: string, priority: ChunkPriority) {
    this.priorityByKey.set(key, { tier: priority.tier, score: priority.score, updatedAt: priority.updatedAt });
  }

  private desiredMeshTasks(e: ChunkSchedulerEntry, targetStep: LodStep, priority: ChunkPriority): MeshTask[] {
    const tasks: MeshTask[] = [];
    if (targetStep === 1) {
      if (e.displayed === 'none' && this.wantsLod(e, FULL_PREVIEW_LOD_STEP)) {
        tasks.push({
          key: e.key,
          kind: 'lod',
          step: FULL_PREVIEW_LOD_STEP,
          tier: Math.min(priority.tier, 0),
          score: priority.score,
          updatedAt: priority.updatedAt,
        });
      }
      if (this.wantsFull(e)) {
        tasks.push({
          key: e.key,
          kind: 'full',
          step: 1,
          tier: e.displayed === 'none' ? Math.max(priority.tier, 3) : priority.tier,
          score: priority.score,
          updatedAt: priority.updatedAt,
        });
      }
      return tasks;
    }
    if (this.wantsLod(e, targetStep)) tasks.push({ key: e.key, kind: 'lod', step: targetStep, ...priority });
    return tasks;
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
    return a.tier - b.tier || a.score - b.score || b.updatedAt - a.updatedAt;
  }

  private compareMeshTasks(a: MeshTask, b: MeshTask, fullBias: boolean): number {
    if (fullBias && a.kind !== b.kind) return a.kind === 'full' ? -1 : 1;
    const priority = this.comparePriority(a, b);
    if (priority !== 0) return priority;
    if (a.kind !== b.kind) return a.kind === 'full' ? -1 : 1;
    return a.step - b.step;
  }

  private shouldStartMeshTask(task: MeshTask, e: ChunkSchedulerEntry, now: number): boolean {
    if (!this.priorityFresh(e, now)) return false;
    if (task.kind === 'full') {
      return e.lastTargetStep === 1 && this.wantsFull(e);
    }
    if (!this.wantsLod(e, task.step)) return false;
    if (e.lastTargetStep === 1) return e.displayed === 'none';
    if (task.step > e.lastTargetStep && e.displayed !== 'none') return false;
    if (e.displayed === 'full' && e.lastTier <= 3 && !e.dirty) return false;
    return true;
  }

  // #endregion

  // #region Backpressure

  private renderBacklog(entries: Iterable<ChunkSchedulerEntry>, activeMeshTasks: number): number {
    let waitingStored = 0;
    for (const e of entries) {
      if (e.state !== 'stored' || e.lastTier > 4) continue;
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
    return share < MIN_FULL_LOD_SHARE;
  }

  // #endregion

  // #region Queue ordering and limits

  private nextIoBatch(queue: Set<string>, batchSize: number, maxTier: number): string[] {
    const out: string[] = [];
    for (const key of queue) {
      const priority = this.priorityByKey.get(key) ?? { tier: 99, score: Infinity, updatedAt: 0 };
      if (priority.tier > maxTier) continue;
      const candidate = { key, ...priority };
      let i = 0;
      while (i < out.length) {
        const existing = this.priorityByKey.get(out[i]) ?? { tier: 99, score: Infinity, updatedAt: 0 };
        if (this.comparePriority(candidate, existing) < 0) break;
        i++;
      }
      out.splice(i, 0, key);
      if (out.length > batchSize) out.pop();
    }
    for (const key of out) queue.delete(key);
    return out;
  }

  private sortKeys(keys: Iterable<string>): string[] {
    return [...keys].sort((a, b) => {
      const ap = this.priorityByKey.get(a) ?? { tier: 99, score: Infinity, updatedAt: 0 };
      const bp = this.priorityByKey.get(b) ?? { tier: 99, score: Infinity, updatedAt: 0 };
      return this.comparePriority(ap, bp);
    });
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
    if (kind === 'hash') this.hashQueue = new Set(sorted);
    else this.fetchQueue = new Set(sorted);
  }

  private trimMeshQueue() {
    const limit = this.activeLimits().maxMeshQueue;
    if (this.meshQueue.size <= limit) return;
    const fullBias = false;
    const sorted = [...this.meshQueue.entries()].sort((a, b) => this.compareMeshTasks(a[1], b[1], fullBias));
    const now = performance.now();
    if (now - this.lastMeshTrimLogAt > 500) {
      this.lastMeshTrimLogAt = now;
      debugLog('scheduler', 'trim-mesh-queue', { before: this.meshQueue.size, after: Math.min(sorted.length, limit), limit });
    }
    this.meshQueue = new Map(sorted.slice(0, limit));
  }

  private meshQueueKey(task: Pick<MeshTask, 'key' | 'kind'>): string {
    return `${task.key}\u0000${task.kind}`;
  }

  private limitCandidates(candidates: ChunkCandidate[]): ChunkCandidate[] {
    const limit = this.activeLimits().maxCandidates;
    return candidates.length > limit ? candidates.slice(0, limit) : candidates;
  }

  private activeLimits(): SchedulerLimits {
    return this.activeStrategy.limits(this.opts);
  }

  // #endregion
}
