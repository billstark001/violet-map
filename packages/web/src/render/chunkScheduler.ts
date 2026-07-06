import * as THREE from 'three';

export type ChunkState = 'checking' | 'hashed' | 'fetching' | 'decoding' | 'stored' | 'absent' | 'error';

const MAX_HASH_BATCHES = 3;
const HASH_BATCH_SIZE = 48;
const MAX_FETCH_BATCHES = 3;
const FETCH_BATCH_SIZE = 24;
const MAX_MESH_QUEUE = 256;
const MAX_IO_QUEUE = 768;
const IO_QUEUE_RETENTION_MS = 2600;
const IO_RENDER_SHARE_TARGET = 0.8;
const MIN_EXISTING_CHUNKS_BEFORE_BALANCE = 64;
const PREDICT_LOOKAHEAD_SECONDS = 0.9;
const PREDICT_FORWARD_BLOCKS = 64;
const PREDICT_MARGIN_CHUNKS = 6;
const UNLOAD_MARGIN_CHUNKS = 8;
const LOAD_FRUSTUM_EXTRA_DEGREES = 18;
const SSE_TARGET_PX = 5.5;
const SSE_REFINE_PX = 6.8;
const SSE_COARSEN_PX = 3.2;
const FAST_MOVE_BLOCKS_PER_SECOND = 32;
const CHUNK_WORLD_MIN_Y = -80;
const CHUNK_WORLD_MAX_Y = 384;
const FULL_HOLD_MARGIN_CHUNKS = 2;
const MIN_FULL_LOD_SHARE = 0.34;

export const LOD_STEPS = [1, 2, 4, 8] as const;
export type LodStep = typeof LOD_STEPS[number];
export type MeshTaskKind = 'full' | 'lod';

export interface ChunkSchedulerOptions {
  viewDistance: number;
  lodDistance: number;
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

type MeshIntent = Pick<MeshTask, 'kind' | 'step'>;

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
  private predictedCamera = new THREE.PerspectiveCamera();
  private loadCamera = new THREE.PerspectiveCamera();
  private predictedLoadCamera = new THREE.PerspectiveCamera();
  private predictedOffset = new THREE.Vector3();
  private tmpForward = new THREE.Vector3();
  private tmpVelocity = new THREE.Vector3();
  private tmpBox = new THREE.Box3();

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
    camera: THREE.PerspectiveCamera,
    now: number,
    force: boolean,
    viewportHeight: number,
    keyFor: (cx: number, cz: number) => string,
    entryFor: (key: string) => ChunkSchedulerEntry | null,
  ): SchedulerFramePlan {
    camera.updateMatrixWorld(true);
    this.updateCameraVelocity(camera.position, now, force);
    this.updateFrustums(camera);
    const candidates = this.buildCandidates(camera, viewportHeight, now, keyFor, entryFor);
    this.updateFrameLoadStats(candidates, entryFor);
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
      for (const task of this.meshQueue.values()) {
        const latest = this.priorityByKey.get(task.key);
        const effective = latest ? { ...task, tier: latest.tier, score: latest.score, updatedAt: latest.updatedAt } : task;
        if (!best || this.compareMeshTasks(effective, best, fullBias) < 0) best = effective;
      }
      if (!best) return null;
      this.meshQueue.delete(best.key);
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

  shouldApplyFullResult(e: ChunkSchedulerEntry, version: number, now: number): boolean {
    if (version < e.displayedVersion || !this.priorityFresh(e, now)) return false;
    return e.lastTargetStep === 1;
  }

  shouldApplyLodResult(e: ChunkSchedulerEntry, step: LodStep, version: number, now: number): boolean {
    if (version < e.displayedVersion || !this.priorityFresh(e, now)) return false;
    if (e.lastTargetStep === 1) return false;
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
    for (const key of this.meshQueue.keys()) if (!keepKeys.has(key)) this.meshQueue.delete(key);
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
    const unloadDistance = this.totalRenderRadius() + PREDICT_MARGIN_CHUNKS + UNLOAD_MARGIN_CHUNKS;
    const all = [...entries];
    for (const e of all) {
      const d = Math.max(Math.abs(e.cx - ccx), Math.abs(e.cz - ccz));
      if (!keepKeys.has(e.key) && d > unloadDistance) out.push(e.key);
    }

    const maxTracked = this.maxTrackedChunks();
    if (all.length - out.length <= maxTracked) return out;
    const already = new Set(out);
    const victims = all
      .filter((e) => !keepKeys.has(e.key) && !already.has(e.key))
      .sort((a, b) => a.lastWantedAt - b.lastWantedAt || b.lastScore - a.lastScore);
    let tracked = all.length - out.length;
    for (const e of victims) {
      if (tracked <= maxTracked) break;
      if (now - e.lastWantedAt < 1000) continue;
      out.push(e.key);
      tracked--;
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
    const existing = this.meshQueue.get(task.key);
    if (existing && this.compareMeshTasks(existing, task, false) <= 0) return;
    this.meshQueue.set(task.key, task);
    this.trimMeshQueue();
  }

  deleteKey(key: string) {
    this.hashQueue.delete(key);
    this.fetchQueue.delete(key);
    this.meshQueue.delete(key);
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

  private updateFrustums(camera: THREE.PerspectiveCamera) {
    this.setLoadFrustum(camera, this.loadCamera, this.currentFrustum);
    camera.getWorldDirection(this.tmpForward);
    this.predictedOffset.copy(this.cameraVelocity).multiplyScalar(PREDICT_LOOKAHEAD_SECONDS);
    const forwardBoost = Math.min(
      Math.max(PREDICT_FORWARD_BLOCKS, this.cameraVelocity.length() * 0.35),
      (this.totalRenderRadius() + PREDICT_MARGIN_CHUNKS) * 16,
    );
    this.predictedOffset.addScaledVector(this.tmpForward, forwardBoost);
    this.predictedCamera.copy(camera);
    this.predictedCamera.position.add(this.predictedOffset);
    this.predictedCamera.updateMatrixWorld(true);
    this.setLoadFrustum(this.predictedCamera, this.predictedLoadCamera, this.predictedFrustum);
  }

  private setLoadFrustum(source: THREE.PerspectiveCamera, target: THREE.PerspectiveCamera, frustum: THREE.Frustum) {
    target.copy(source);
    target.fov = Math.min(120, source.fov + LOAD_FRUSTUM_EXTRA_DEGREES);
    target.updateProjectionMatrix();
    target.updateMatrixWorld(true);
    this.frustumMatrix.multiplyMatrices(target.projectionMatrix, target.matrixWorldInverse);
    frustum.setFromProjectionMatrix(this.frustumMatrix);
  }

  // #endregion

  // #region Candidate geometry and LOD

  private buildCandidates(
    camera: THREE.PerspectiveCamera,
    viewportHeight: number,
    now: number,
    keyFor: (cx: number, cz: number) => string,
    entryFor: (key: string) => ChunkSchedulerEntry | null,
  ): ChunkCandidate[] {
    const ccx = Math.floor(camera.position.x / 16);
    const ccz = Math.floor(camera.position.z / 16);
    const predictedX = camera.position.x + this.predictedOffset.x;
    const predictedZ = camera.position.z + this.predictedOffset.z;
    const pcx = Math.floor(predictedX / 16);
    const pcz = Math.floor(predictedZ / 16);
    const fullRadius = this.fullRadius();
    const total = this.totalRenderRadius();
    const scanRadius = total + PREDICT_MARGIN_CHUNKS;
    const movingFast = this.cameraVelocity.length() > FAST_MOVE_BLOCKS_PER_SECOND;
    const minCx = Math.min(ccx, pcx) - scanRadius;
    const maxCx = Math.max(ccx, pcx) + scanRadius;
    const minCz = Math.min(ccz, pcz) - scanRadius;
    const maxCz = Math.max(ccz, pcz) + scanRadius;
    const out: ChunkCandidate[] = [];

    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const currentCheb = Math.max(Math.abs(cx - ccx), Math.abs(cz - ccz));
        const predictedCheb = Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz));
        const forcedFull = currentCheb <= fullRadius;
        if (!forcedFull && currentCheb > total && predictedCheb > total + PREDICT_MARGIN_CHUNKS) continue;

        const currentFrustum = currentCheb <= total && (forcedFull || this.chunkIntersectsFrustum(this.currentFrustum, cx, cz));
        const predictedFrustum = !currentFrustum
          && predictedCheb <= total + PREDICT_MARGIN_CHUNKS
          && this.chunkIntersectsFrustum(this.predictedFrustum, cx, cz);
        if (!forcedFull && !currentFrustum && !predictedFrustum) continue;

        const key = keyFor(cx, cz);
        const e = entryFor(key) ?? undefined;
        const distCurrent = this.distanceToChunk(camera.position, cx, cz);
        const distPredicted = this.distanceToChunk(this.predictedCamera.position, cx, cz);
        const sseDistance = currentFrustum || forcedFull ? distCurrent : distPredicted;
        let targetStep = this.selectLodStep(sseDistance, camera, viewportHeight, e, currentCheb, predictedFrustum, movingFast);
        if (predictedFrustum && !forcedFull) targetStep = Math.max(targetStep, movingFast ? 4 : 2) as LodStep;
        const tier = this.tierForCandidate(e, targetStep, currentFrustum, predictedFrustum, forcedFull);
        const score = (currentFrustum || forcedFull ? distCurrent : distPredicted) - this.screenErrorForStep(targetStep, sseDistance, camera, viewportHeight) * 8;
        out.push({ key, cx, cz, targetStep, currentFrustum, predictedFrustum, forcedFull, tier, score, updatedAt: now });
      }
    }

    out.sort((a, b) => a.tier - b.tier || a.score - b.score);
    return out;
  }

  private chunkIntersectsFrustum(frustum: THREE.Frustum, cx: number, cz: number): boolean {
    const x = cx * 16;
    const z = cz * 16;
    this.tmpBox.min.set(x, CHUNK_WORLD_MIN_Y, z);
    this.tmpBox.max.set(x + 16, CHUNK_WORLD_MAX_Y, z + 16);
    return frustum.intersectsBox(this.tmpBox);
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

  private fullRadius(): number {
    return Math.max(0, Math.floor(this.opts.viewDistance));
  }

  private totalRenderRadius(): number {
    return Math.max(0, this.fullRadius() + Math.max(0, Math.floor(this.opts.lodDistance)));
  }

  private screenErrorForStep(step: LodStep, distance: number, camera: THREE.PerspectiveCamera, viewportHeight: number): number {
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const pixelsPerBlock = Math.max(1, viewportHeight) / (2 * Math.tan(fov * 0.5) * Math.max(1, distance));
    const geometricError = step <= 1 ? 0.5 : step * 0.75;
    return geometricError * pixelsPerBlock;
  }

  private baseLodStep(distance: number, camera: THREE.PerspectiveCamera, viewportHeight: number): LodStep {
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
    camera: THREE.PerspectiveCamera,
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

  private desiredMeshTask(e: ChunkSchedulerEntry, targetStep: LodStep): MeshIntent | null {
    if (targetStep === 1) return this.wantsFull(e) ? { kind: 'full', step: 1 } : null;
    return this.wantsLod(e, targetStep) ? { kind: 'lod', step: targetStep } : null;
  }

  private enqueueDesiredMeshTask(
    key: string,
    e: ChunkSchedulerEntry,
    targetStep: LodStep,
    priority: ChunkPriority,
  ) {
    const intent = this.desiredMeshTask(e, targetStep);
    if (!intent) return;
    this.enqueueMeshTask({ key, ...intent, tier: priority.tier, score: priority.score, updatedAt: priority.updatedAt });
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
    if (e.lastTargetStep === 1) return false;
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

  private shouldLoadMore(activeIoBatches: number): boolean {
    const loadWork = this.loadBacklog(activeIoBatches);
    if (loadWork <= 0) return false;
    if (this.currentFrustumLoaded()) return false;
    if (this.shouldPrioritizeInitialLoad()) return true;
    if (this.renderStats.nbt <= 0) return false;
    return this.readyShare() >= IO_RENDER_SHARE_TARGET;
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
    if (!this.shouldLoadMore(opts.activeBatches)) return [];
    const batchSize = prioritizeLoad || renderWork <= 0
      ? opts.batchSize
      : Math.max(opts.busyBatchFloor, Math.floor(opts.batchSize / 2));
    return this.nextIoBatch(queue, batchSize, renderWork > 0 ? 4 : 99);
  }

  private currentFrustumLoaded(): boolean {
    const { currentFrustumTotal, currentFrustumLoaded } = this.frameLoadStats;
    return currentFrustumTotal <= 0 || currentFrustumLoaded >= currentFrustumTotal;
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
    if (queue.size <= MAX_IO_QUEUE) return;
    const sorted = this.sortKeys(queue).slice(0, MAX_IO_QUEUE);
    if (kind === 'hash') this.hashQueue = new Set(sorted);
    else this.fetchQueue = new Set(sorted);
  }

  private trimMeshQueue() {
    if (this.meshQueue.size <= MAX_MESH_QUEUE) return;
    const fullBias = false;
    const sorted = [...this.meshQueue.values()].sort((a, b) => this.compareMeshTasks(a, b, fullBias));
    this.meshQueue = new Map(sorted.slice(0, MAX_MESH_QUEUE).map((task) => [task.key, task]));
  }

  private maxTrackedChunks(): number {
    const total = this.totalRenderRadius() + PREDICT_MARGIN_CHUNKS;
    return Math.max(768, Math.min(9000, Math.round(total * total * 2.1)));
  }

  // #endregion
}
