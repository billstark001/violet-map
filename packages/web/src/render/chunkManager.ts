import * as THREE from 'three';
import type { DimensionDef, MeshBuffers, RenderLayer } from '@violet-map/core';
import { fetchChunkHashes, fetchChunks, type ChunkHashPayload, type ChunkPayload } from '../api';
import { chunkKey, type SectionMeshMsg, WorkerInit, WorkerRequest, WorkerResponse } from '../worker/protocol';
import { getCachedFull, getCachedLod, putCachedFull, putCachedLod, type MeshCacheKeyParts } from '../meshCache';
import type { TerrainMaterials } from './materials';

type ChunkState = 'checking' | 'hashed' | 'fetching' | 'stored' | 'absent' | 'error';
const UPDATE_INTERVAL_MS = 80;
const MAX_HASH_BATCHES = 3;
const HASH_BATCH_SIZE = 48;
const MAX_FETCH_BATCHES = 3;
const FETCH_BATCH_SIZE = 24;
const MAX_ACTIVE_MESH_TASKS = 4;
const MAX_MESH_QUEUE = 256;
const MAX_IO_QUEUE = 768;
const RENDER_BACKLOG_LIGHT_LIMIT = 48;
const RENDER_BACKLOG_SOFT_LIMIT = 96;
const RENDER_BACKLOG_HARD_LIMIT = 180;
const IO_QUEUE_RETENTION_MS = 2600;
const PREDICT_LOOKAHEAD_SECONDS = 0.9;
const PREDICT_FORWARD_BLOCKS = 64;
const PREDICT_MARGIN_CHUNKS = 6;
const UNLOAD_MARGIN_CHUNKS = 8;
const LOAD_FRUSTUM_EXTRA_DEGREES = 18;
const LOD_DISTANCE_EXTRA_CHUNKS = 4;
const FORCED_FULL_MIN_RADIUS = 3;
const FORCED_FULL_MAX_RADIUS = 5;
const FORCED_FULL_FAST_RADIUS = 2;
const SSE_TARGET_PX = 5.5;
const SSE_REFINE_PX = 6.8;
const SSE_COARSEN_PX = 3.2;
const FAST_MOVE_BLOCKS_PER_SECOND = 32;
const CHUNK_WORLD_MIN_Y = -80;
const CHUNK_WORLD_MAX_Y = 384;
const LOD_STEPS = [1, 2, 4, 8] as const;
type MeshCacheBaseParts = Omit<MeshCacheKeyParts, 'mode' | 'step'>;
type LodStep = typeof LOD_STEPS[number];
type MeshTaskKind = 'full' | 'lod';

interface ChunkPriority {
  tier: number;
  score: number;
  updatedAt: number;
}

interface MeshTask extends ChunkPriority {
  key: string;
  kind: MeshTaskKind;
  step: LodStep;
}

interface ChunkCandidate extends ChunkPriority {
  key: string;
  cx: number;
  cz: number;
  targetStep: LodStep;
  currentFrustum: boolean;
  predictedFrustum: boolean;
  forcedFull: boolean;
}

interface CachePartsResult {
  parts: MeshCacheBaseParts;
  stable: boolean;
}

interface ChunkEntry {
  cx: number; cz: number;
  state: ChunkState;
  pendingFullVersion: number;
  pendingLodVersion: number;
  pendingFull: boolean;
  pendingLod: boolean;
  pendingLodStep: number;
  pendingFullCacheParts: MeshCacheBaseParts | null;
  pendingLodCacheParts: MeshCacheBaseParts | null;
  pendingFullDirtyToken: number;
  pendingLodDirtyToken: number;
  displayed: 'none' | 'full' | 'lod';
  displayedVersion: number;
  displayedLodStep: number;
  dirty: boolean;
  dirtyToken: number;
  group: THREE.Group | null;
  biome: string;
  surfaceY: number;
  sourceHash: string | null;
  nbtHash: string | null;
  source: 'region' | 'chunk' | null;
  lastWantedAt: number;
  lastTier: number;
  lastScore: number;
  lastTargetStep: LodStep;
  lastForcedFull: boolean;
}

export interface ChunkManagerOptions {
  world: string;
  dimension: string;
  renderKey: string;
  dimensionDef: DimensionDef;
  viewDistance: number;
  lodDistance: number;
}

export class ChunkManager {
  private worker: Worker;
  private chunks = new Map<string, ChunkEntry>();
  private checking = 0;
  private hashQueue = new Set<string>();
  private hashTimer: ReturnType<typeof setTimeout> | null = null;
  private fetching = 0;
  private fetchQueue = new Set<string>();
  private fetchTimer: ReturnType<typeof setTimeout> | null = null;
  private activeMeshTasks = 0;
  private inFlightMeshVersions = new Set<number>();
  private meshQueue = new Map<string, MeshTask>();
  private priorityByKey = new Map<string, ChunkPriority>();
  private versionCounter = 0;
  private lastUpdate = 0;
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
  private tmpBox = new THREE.Box3();
  private disposed = false;
  readonly root = new THREE.Group();
  onStats?: (s: { loaded: number; rendered: number }) => void;

  constructor(
    private scene: THREE.Scene,
    private materials: TerrainMaterials,
    private initPayload: Omit<WorkerInit, 'type'>,
    public opts: ChunkManagerOptions,
  ) {
    this.root.matrixAutoUpdate = false;
    this.root.updateMatrix();
    scene.add(this.root);
    this.worker = new Worker(new URL('../worker/meshWorker.ts', import.meta.url), { type: 'module' });
    this.worker.postMessage({ type: 'init', ...initPayload } satisfies WorkerInit);
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.handleMessage(ev.data);
  }

  private key(cx: number, cz: number) { return chunkKey(this.opts.world, this.opts.dimension, cx, cz); }
  private send(msg: WorkerRequest, transfer: Transferable[] = []) { this.worker.postMessage(msg, transfer); }

  biomeAt(cx: number, cz: number): string | null {
    const e = this.chunks.get(this.key(cx, cz));
    return e?.state === 'stored' ? e.biome : null;
  }
  surfaceYAt(cx: number, cz: number): number | null {
    const e = this.chunks.get(this.key(cx, cz));
    return e?.state === 'stored' ? e.surfaceY : null;
  }

  /** 每帧调用（内部节流）。 */
  update(camera: THREE.PerspectiveCamera, now: number, force = false, viewportHeight = window.innerHeight) {
    if (!force && now - this.lastUpdate < UPDATE_INTERVAL_MS) return;
    this.lastUpdate = now;

    camera.updateMatrixWorld(true);
    this.updateCameraVelocity(camera.position, now, force);
    this.updateFrustums(camera);

    const ccx = Math.floor(camera.position.x / 16);
    const ccz = Math.floor(camera.position.z / 16);
    const keepKeys = new Set<string>();
    const candidates = this.buildCandidates(camera, viewportHeight, now);

    for (const candidate of candidates) {
      keepKeys.add(candidate.key);
      this.rememberPriority(candidate.key, candidate);
      const e = this.ensureEntry(candidate.cx, candidate.cz, now);
      e.lastWantedAt = now;
      e.lastTier = candidate.tier;
      e.lastScore = candidate.score;
      e.lastTargetStep = candidate.targetStep;
      e.lastForcedFull = candidate.forcedFull;
      this.scheduleCandidate(candidate, e);
    }

    this.pruneQueues(keepKeys, now);
    this.expirePriorities(now);
    this.evictChunks(ccx, ccz, keepKeys, now);
    this.flushMeshQueue();
    this.flushHashQueue();
    this.flushFetchQueue();
    this.flushMeshQueue();
    this.reportStats();
  }

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
    this.cameraVelocity.lerp(new THREE.Vector3(instantX, instantY, instantZ), 0.35);
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

  private buildCandidates(camera: THREE.PerspectiveCamera, viewportHeight: number, now: number): ChunkCandidate[] {
    const ccx = Math.floor(camera.position.x / 16);
    const ccz = Math.floor(camera.position.z / 16);
    const predictedX = camera.position.x + this.predictedOffset.x;
    const predictedZ = camera.position.z + this.predictedOffset.z;
    const pcx = Math.floor(predictedX / 16);
    const pcz = Math.floor(predictedZ / 16);
    const total = this.totalRenderRadius();
    const scanRadius = total + PREDICT_MARGIN_CHUNKS;
    const forcedRadius = this.forcedFullRadius();
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
        const forcedFull = currentCheb <= (movingFast ? FORCED_FULL_FAST_RADIUS : forcedRadius);
        if (!forcedFull && currentCheb > total && predictedCheb > total + PREDICT_MARGIN_CHUNKS) continue;

        const currentFrustum = currentCheb <= total && (forcedFull || this.chunkIntersectsFrustum(this.currentFrustum, cx, cz));
        const predictedFrustum = !currentFrustum
          && predictedCheb <= total + PREDICT_MARGIN_CHUNKS
          && this.chunkIntersectsFrustum(this.predictedFrustum, cx, cz);
        if (!forcedFull && !currentFrustum && !predictedFrustum) continue;

        const key = this.key(cx, cz);
        const e = this.chunks.get(key);
        const distCurrent = this.distanceToChunk(camera.position, cx, cz);
        const distPredicted = this.distanceToChunk(this.predictedCamera.position, cx, cz);
        const sseDistance = currentFrustum || forcedFull ? distCurrent : distPredicted;
        let targetStep = this.selectLodStep(sseDistance, camera, viewportHeight, e, forcedFull);
        if (movingFast && !forcedFull && targetStep === 1) targetStep = 2;
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

  private forcedFullRadius(): number {
    return Math.max(
      FORCED_FULL_MIN_RADIUS,
      Math.min(FORCED_FULL_MAX_RADIUS, Math.floor(this.opts.viewDistance * 0.16)),
    );
  }

  private effectiveLodDistance(): number {
    return Math.max(0, this.opts.lodDistance + LOD_DISTANCE_EXTRA_CHUNKS);
  }

  private totalRenderRadius(): number {
    return Math.max(0, this.opts.viewDistance + this.effectiveLodDistance());
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

  private currentStep(e: ChunkEntry | undefined): LodStep | null {
    if (!e || e.displayed === 'none') return null;
    if (e.displayed === 'full') return 1;
    return (LOD_STEPS.includes(e.displayedLodStep as LodStep) ? e.displayedLodStep : 8) as LodStep;
  }

  private selectLodStep(
    distance: number,
    camera: THREE.PerspectiveCamera,
    viewportHeight: number,
    e: ChunkEntry | undefined,
    forcedFull: boolean,
  ): LodStep {
    if (forcedFull) return 1;
    const base = this.baseLodStep(distance, camera, viewportHeight);
    const current = this.currentStep(e);
    if (!current || e?.dirty) return base;
    if (base > current) {
      return this.screenErrorForStep(base, distance, camera, viewportHeight) < SSE_COARSEN_PX ? base : current;
    }
    if (base < current) {
      return this.screenErrorForStep(current, distance, camera, viewportHeight) > SSE_REFINE_PX ? base : current;
    }
    return base;
  }

  private tierForCandidate(
    e: ChunkEntry | undefined,
    targetStep: LodStep,
    currentFrustum: boolean,
    predictedFrustum: boolean,
    forcedFull: boolean,
  ): number {
    const displayedStep = this.currentStep(e);
    const empty = !e || e.displayed === 'none';
    if (forcedFull && targetStep === 1 && empty) return 0;
    if (forcedFull && targetStep === 1 && e?.displayed !== 'full') return 1;
    if (currentFrustum && empty) return 2;
    if (currentFrustum && (!displayedStep || targetStep < displayedStep || e?.dirty || (targetStep === 1 && e?.displayed !== 'full'))) return 3;
    if (predictedFrustum) return 4;
    return 5;
  }

  private ensureEntry(cx: number, cz: number, now: number): ChunkEntry {
    const key = this.key(cx, cz);
    let e = this.chunks.get(key);
    if (e) return e;
    e = {
      cx, cz,
      state: 'checking',
      pendingFullVersion: -1,
      pendingLodVersion: -1,
      pendingFull: false,
      pendingLod: false,
      pendingLodStep: 0,
      pendingFullCacheParts: null,
      pendingLodCacheParts: null,
      pendingFullDirtyToken: 0,
      pendingLodDirtyToken: 0,
      displayed: 'none',
      displayedVersion: -1,
      displayedLodStep: 0,
      dirty: false,
      dirtyToken: 0,
      group: null,
      biome: 'minecraft:plains',
      surfaceY: 64,
      sourceHash: null,
      nbtHash: null,
      source: null,
      lastWantedAt: now,
      lastTier: 6,
      lastScore: Infinity,
      lastTargetStep: 8,
      lastForcedFull: false,
    };
    this.chunks.set(key, e);
    return e;
  }

  private rememberPriority(key: string, priority: ChunkPriority) {
    this.priorityByKey.set(key, { tier: priority.tier, score: priority.score, updatedAt: priority.updatedAt });
  }

  private comparePriority(a: ChunkPriority, b: ChunkPriority): number {
    return a.tier - b.tier || a.score - b.score || b.updatedAt - a.updatedAt;
  }

  private scheduleCandidate(candidate: ChunkCandidate, e: ChunkEntry) {
    if (e.state === 'absent' || e.state === 'error') {
      this.removeMesh(e);
      return;
    }
    if (e.state === 'checking') {
      this.enqueueHash(candidate.key);
      return;
    }
    if (e.state === 'hashed' || e.state === 'fetching') {
      this.enqueueFetch(candidate.key);
      return;
    }
    if (e.state !== 'stored') return;

    if (candidate.targetStep === 1) {
      if (e.displayed === 'none') {
        this.enqueuePlaceholderLod(candidate.key, e, candidate);
        return;
      }
      if ((e.displayed !== 'full' || e.dirty) && !e.pendingFull) {
        this.enqueueMeshTask({ ...candidate, kind: 'full', step: 1 });
      }
      return;
    }

    const wantsLod = e.displayed !== 'lod' || e.displayedLodStep !== candidate.targetStep || e.dirty;
    if (wantsLod && !(e.pendingLod && e.pendingLodStep === candidate.targetStep)) {
      this.enqueueMeshTask({ ...candidate, kind: 'lod', step: candidate.targetStep });
    }
  }

  private placeholderStep(forcedFull: boolean): LodStep {
    return forcedFull ? 1 : 2;
  }

  private enqueuePlaceholderLod(key: string, e: ChunkEntry, priority: ChunkPriority & { forcedFull?: boolean }) {
    if (e.pendingLod) return;
    const step = this.placeholderStep(!!priority.forcedFull);
    const existing = this.meshQueue.get(key);
    if (existing?.kind === 'full') this.meshQueue.delete(key);
    this.enqueueMeshTask({
      key,
      kind: 'lod',
      step,
      tier: Math.min(priority.tier, priority.forcedFull ? 0 : 2),
      score: priority.score - 0.5,
      updatedAt: priority.updatedAt,
    });
  }

  private scheduleStoredFromLastPriority(key: string, e: ChunkEntry) {
    if (e.state !== 'stored' || performance.now() - e.lastWantedAt > IO_QUEUE_RETENTION_MS) return;
    const priority = this.priorityByKey.get(key) ?? { tier: e.lastTier, score: e.lastScore, updatedAt: e.lastWantedAt };
    if (e.lastTargetStep === 1) {
      if (e.displayed === 'none') {
        this.enqueuePlaceholderLod(key, e, { ...priority, forcedFull: e.lastForcedFull });
      } else if ((e.displayed !== 'full' || e.dirty) && !e.pendingFull) {
        this.enqueueMeshTask({ key, kind: 'full', step: 1, ...priority });
      }
      return;
    }
    const step = e.lastTargetStep;
    const wantsLod = e.displayed !== 'lod' || e.displayedLodStep !== step || e.dirty;
    if (wantsLod && !(e.pendingLod && e.pendingLodStep === step)) {
      this.enqueueMeshTask({ key, kind: 'lod', step, ...priority });
    }
  }

  private enqueueMeshTask(task: MeshTask) {
    const existing = this.meshQueue.get(task.key);
    if (existing && this.compareMeshTasks(existing, task) <= 0) return;
    this.meshQueue.set(task.key, task);
    this.trimMeshQueue();
  }

  private compareMeshTasks(a: MeshTask, b: MeshTask): number {
    const priority = this.comparePriority(a, b);
    if (priority !== 0) return priority;
    if (a.kind !== b.kind) return a.kind === 'full' ? -1 : 1;
    return a.step - b.step;
  }

  private priorityFresh(e: ChunkEntry, maxAge = IO_QUEUE_RETENTION_MS): boolean {
    return performance.now() - e.lastWantedAt <= maxAge;
  }

  private shouldStartMeshTask(task: MeshTask, e: ChunkEntry): boolean {
    if (!this.priorityFresh(e)) return false;
    if (task.kind === 'full') {
      return e.lastTargetStep === 1 && !e.pendingFull && (e.displayed !== 'full' || e.dirty);
    }
    if (e.pendingLod && e.pendingLodStep === task.step) return false;
    if (e.lastTargetStep === 1) {
      return e.displayed === 'none' && task.step === this.placeholderStep(e.lastForcedFull);
    }
    if (task.step > e.lastTargetStep && e.displayed !== 'none') return false;
    if (e.displayed === 'full' && e.lastTier <= 3 && !e.dirty) return false;
    return true;
  }

  private shouldApplyFullResult(e: ChunkEntry, version: number): boolean {
    if (version < e.displayedVersion || !this.priorityFresh(e)) return false;
    return e.lastTargetStep === 1;
  }

  private shouldApplyLodResult(e: ChunkEntry, step: LodStep, version: number): boolean {
    if (version < e.displayedVersion || !this.priorityFresh(e)) return false;
    if (e.lastTargetStep === 1) return e.displayed === 'none' && step === this.placeholderStep(e.lastForcedFull);
    if (step > e.lastTargetStep && e.displayed !== 'none') return false;
    if (e.displayed === 'full' && e.lastTier <= 3 && !e.dirty) return false;
    return true;
  }

  private rescheduleStoredIfFresh(key: string, e: ChunkEntry) {
    if (!this.priorityFresh(e)) return;
    this.scheduleStoredFromLastPriority(key, e);
    this.flushMeshQueue();
  }

  private flushMeshQueue() {
    while (this.activeMeshTasks < MAX_ACTIVE_MESH_TASKS && this.meshQueue.size > 0) {
      const task = this.nextMeshTask();
      if (!task) return;
      const e = this.chunks.get(task.key);
      if (!e || e.state !== 'stored') continue;
      if (!this.shouldStartMeshTask(task, e)) continue;
      if (task.kind === 'full') {
        if (e.displayed === 'full' && !e.dirty) continue;
        if (e.pendingFull) continue;
        this.requestFull(task.key, e);
      } else {
        if (e.displayed === 'lod' && e.displayedLodStep === task.step && !e.dirty) continue;
        if (e.pendingLod && e.pendingLodStep === task.step) continue;
        this.requestLod(task.key, e, task.step);
      }
    }
  }

  private nextMeshTask(): MeshTask | null {
    let best: MeshTask | null = null;
    for (const task of this.meshQueue.values()) {
      const latest = this.priorityByKey.get(task.key);
      const effective = latest ? { ...task, tier: latest.tier, score: latest.score, updatedAt: latest.updatedAt } : task;
      if (!best || this.compareMeshTasks(effective, best) < 0) best = effective;
    }
    if (best) this.meshQueue.delete(best.key);
    return best;
  }

  private trimMeshQueue() {
    if (this.meshQueue.size <= MAX_MESH_QUEUE) return;
    const sorted = [...this.meshQueue.values()].sort((a, b) => this.compareMeshTasks(a, b));
    this.meshQueue = new Map(sorted.slice(0, MAX_MESH_QUEUE).map((task) => [task.key, task]));
  }

  private finishActiveMesh(version?: number) {
    if (version !== undefined && !this.inFlightMeshVersions.delete(version)) return;
    this.activeMeshTasks = Math.max(0, this.activeMeshTasks - 1);
    this.flushMeshQueue();
  }

  private markWorkerMesh(version: number) {
    this.inFlightMeshVersions.add(version);
  }

  private pruneQueues(keepKeys: Set<string>, now: number) {
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

  private expirePriorities(now: number) {
    for (const [key, priority] of this.priorityByKey) {
      if (now - priority.updatedAt > IO_QUEUE_RETENTION_MS) this.priorityByKey.delete(key);
    }
  }

  private trimIoQueue(kind: 'hash' | 'fetch') {
    const queue = kind === 'hash' ? this.hashQueue : this.fetchQueue;
    if (queue.size <= MAX_IO_QUEUE) return;
    const sorted = this.sortKeys(queue).slice(0, MAX_IO_QUEUE);
    if (kind === 'hash') this.hashQueue = new Set(sorted);
    else this.fetchQueue = new Set(sorted);
  }

  private evictChunks(ccx: number, ccz: number, keepKeys: Set<string>, now: number) {
    const total = this.totalRenderRadius();
    const unloadDistance = total + PREDICT_MARGIN_CHUNKS + UNLOAD_MARGIN_CHUNKS;
    for (const [key, e] of this.chunks) {
      const d = Math.max(Math.abs(e.cx - ccx), Math.abs(e.cz - ccz));
      if (!keepKeys.has(key) && d > unloadDistance) this.dropEntry(key, e);
    }

    const maxTracked = this.maxTrackedChunks();
    if (this.chunks.size <= maxTracked) return;
    const victims = [...this.chunks.entries()]
      .filter(([key]) => !keepKeys.has(key))
      .sort(([, a], [, b]) => a.lastWantedAt - b.lastWantedAt || b.lastScore - a.lastScore);
    for (const [key, e] of victims) {
      if (this.chunks.size <= maxTracked) break;
      if (now - e.lastWantedAt < 1000) continue;
      this.dropEntry(key, e);
    }
  }

  private maxTrackedChunks(): number {
    const total = this.totalRenderRadius() + PREDICT_MARGIN_CHUNKS;
    return Math.max(768, Math.min(4200, Math.round(total * total * 2.1)));
  }

  private dropEntry(key: string, e: ChunkEntry) {
    this.removeMesh(e);
    if (e.state === 'stored') this.send({ type: 'drop', key });
    this.chunks.delete(key);
    this.hashQueue.delete(key);
    this.fetchQueue.delete(key);
    this.meshQueue.delete(key);
    this.priorityByKey.delete(key);
  }

  private cacheParts(e: ChunkEntry): MeshCacheBaseParts {
    return {
      world: this.opts.world,
      dimension: this.opts.dimension,
      renderKey: this.opts.renderKey,
      cx: e.cx,
      cz: e.cz,
      sourceHash: e.sourceHash!,
    };
  }

  private markDirty(e: ChunkEntry) {
    e.dirty = true;
    e.dirtyToken++;
  }

  private clearDirtyIfUnchanged(e: ChunkEntry, dirtyToken: number) {
    if (e.dirtyToken === dirtyToken) e.dirty = false;
  }

  private neighborhoodCacheParts(e: ChunkEntry): CachePartsResult | null {
    if (!e.sourceHash) return null;
    const parts: string[] = [];
    let stable = true;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = this.chunks.get(this.key(e.cx + dx, e.cz + dz));
        if (!n) {
          parts.push('unknown');
          stable = false;
        }
        else if (n.state === 'absent' || n.state === 'error') parts.push('missing');
        else if (n.state === 'stored' && n.sourceHash) parts.push(n.sourceHash);
        else {
          parts.push('unknown');
          stable = false;
        }
      }
    }
    return { parts: { ...this.cacheParts(e), sourceHash: parts.join('.') }, stable };
  }

  private requestFull(key: string, e: ChunkEntry) {
    if (this.activeMeshTasks >= MAX_ACTIVE_MESH_TASKS) {
      const priority = this.priorityByKey.get(key) ?? { tier: 3, score: 0, updatedAt: performance.now() };
      this.enqueueMeshTask({ key, kind: 'full', step: 1, ...priority });
      return;
    }
    const cache = this.neighborhoodCacheParts(e);
    if (!cache) {
      this.enqueueHash(key);
      return;
    }
    this.activeMeshTasks++;
    e.pendingFull = true;
    e.pendingFullCacheParts = cache.stable ? cache.parts : null;
    e.pendingFullDirtyToken = e.dirtyToken;
    e.pendingFullVersion = ++this.versionCounter;
    const version = e.pendingFullVersion;
    if (!cache.stable) {
      this.startFullMeshing(key, e, version);
      return;
    }
    void getCachedFull(cache.parts).then((hit) => {
      if (this.disposed) { this.finishActiveMesh(); return; }
      const current = this.chunks.get(key);
      if (!current || current.pendingFullVersion !== version) {
        this.finishActiveMesh();
        return;
      }
      if (hit) {
        current.pendingFull = false;
        current.pendingFullCacheParts = null;
        this.finishActiveMesh();
        if (!this.shouldApplyFullResult(current, version)) {
          this.rescheduleStoredIfFresh(key, current);
          return;
        }
        this.displayFull(current, hit, version);
        this.clearDirtyIfUnchanged(current, current.pendingFullDirtyToken);
        return;
      }
      this.startFullMeshing(key, current, version);
    }).catch(() => {
      const current = this.chunks.get(key);
      if (current?.pendingFullVersion === version) {
        current.pendingFull = false;
        current.pendingFullCacheParts = null;
        if (current.state !== 'stored') this.enqueueFetch(key);
      }
      this.finishActiveMesh();
    });
  }

  private startFullMeshing(key: string, current: ChunkEntry, version: number) {
    if (current.state !== 'stored') {
      current.pendingFull = false;
      current.pendingFullCacheParts = null;
      this.enqueueFetch(key);
      this.finishActiveMesh();
      return;
    }
    if (!this.shouldApplyFullResult(current, version)) {
      current.pendingFull = false;
      current.pendingFullCacheParts = null;
      this.finishActiveMesh();
      this.rescheduleStoredIfFresh(key, current);
      return;
    }
    current.pendingFull = true;
    this.markWorkerMesh(version);
    this.send({ type: 'mesh', key, version });
  }

  private requestLod(key: string, e: ChunkEntry, step: LodStep) {
    if (this.activeMeshTasks >= MAX_ACTIVE_MESH_TASKS) {
      const priority = this.priorityByKey.get(key) ?? { tier: 4, score: 0, updatedAt: performance.now() };
      this.enqueueMeshTask({ key, kind: 'lod', step, ...priority });
      return;
    }
    if (!e.sourceHash) {
      this.enqueueHash(key);
      return;
    }
    if (e.state !== 'stored') {
      this.enqueueFetch(key);
      return;
    }
    const cache = this.neighborhoodCacheParts(e);
    if (!cache) {
      this.enqueueHash(key);
      return;
    }
    this.activeMeshTasks++;
    e.pendingLod = true;
    e.pendingLodStep = step;
    e.pendingLodCacheParts = cache.stable ? cache.parts : null;
    e.pendingLodDirtyToken = e.dirtyToken;
    e.pendingLodVersion = ++this.versionCounter;
    const version = e.pendingLodVersion;
    if (!cache.stable) {
      if (!this.shouldApplyLodResult(e, step, version)) {
        e.pendingLod = false;
        e.pendingLodStep = 0;
        e.pendingLodCacheParts = null;
        this.finishActiveMesh();
        this.rescheduleStoredIfFresh(key, e);
        return;
      }
      this.markWorkerMesh(version);
      this.send({ type: 'lod', key, step, version });
      return;
    }
    void getCachedLod({ ...cache.parts, step }).then((hit) => {
      if (this.disposed) { this.finishActiveMesh(); return; }
      const current = this.chunks.get(key);
      if (!current || current.pendingLodVersion !== version || current.pendingLodStep !== step) {
        this.finishActiveMesh();
        return;
      }
      if (hit !== undefined) {
        current.pendingLod = false;
        current.pendingLodStep = 0;
        current.pendingLodCacheParts = null;
        this.finishActiveMesh();
        if (!this.shouldApplyLodResult(current, step, version)) {
          this.rescheduleStoredIfFresh(key, current);
          return;
        }
        this.displayLod(current, hit, version, step);
        this.clearDirtyIfUnchanged(current, current.pendingLodDirtyToken);
        return;
      }
      if (current.state !== 'stored') {
        current.pendingLod = false;
        current.pendingLodStep = 0;
        current.pendingLodCacheParts = null;
        this.enqueueFetch(key);
        this.finishActiveMesh();
        return;
      }
      current.pendingLod = true;
      current.pendingLodStep = step;
      if (!this.shouldApplyLodResult(current, step, version)) {
        current.pendingLod = false;
        current.pendingLodStep = 0;
        current.pendingLodCacheParts = null;
        this.finishActiveMesh();
        this.rescheduleStoredIfFresh(key, current);
        return;
      }
      this.markWorkerMesh(version);
      this.send({ type: 'lod', key, step, version });
    }).catch(() => {
      const current = this.chunks.get(key);
      if (current?.pendingLodVersion === version && current.pendingLodStep === step) {
        current.pendingLod = false;
        current.pendingLodStep = 0;
        current.pendingLodCacheParts = null;
        if (current.state !== 'stored') this.enqueueFetch(key);
      }
      this.finishActiveMesh();
    });
  }

  private enqueueHash(key: string) {
    this.hashQueue.add(key);
    if (this.hashTimer) return;
    this.hashTimer = setTimeout(() => {
      this.hashTimer = null;
      this.flushHashQueue();
    }, 20);
  }

  private flushHashQueue() {
    const backlog = this.renderBacklog();
    const maxBatches = backlog >= RENDER_BACKLOG_SOFT_LIMIT ? 1 : MAX_HASH_BATCHES;
    const batchSize = backlog >= RENDER_BACKLOG_SOFT_LIMIT ? Math.max(12, Math.floor(HASH_BATCH_SIZE / 2)) : HASH_BATCH_SIZE;
    const maxTier = this.ioTierLimit('hash', backlog);
    while (this.checking < maxBatches && this.hashQueue.size > 0) {
      const keys = this.nextIoBatch(this.hashQueue, batchSize, maxTier);
      if (!keys.length) break;
      for (const key of keys) this.hashQueue.delete(key);
      void this.fetchHashBatch(keys);
    }
    if (this.hashQueue.size > 0 && !this.hashTimer) {
      this.hashTimer = setTimeout(() => {
        this.hashTimer = null;
        this.flushHashQueue();
      }, 50);
    }
  }

  private enqueueFetch(key: string) {
    const e = this.chunks.get(key);
    if (e && e.state !== 'stored') e.state = 'fetching';
    this.fetchQueue.add(key);
    if (this.fetchTimer) return;
    this.fetchTimer = setTimeout(() => {
      this.fetchTimer = null;
      this.flushFetchQueue();
    }, 20);
  }

  private flushFetchQueue() {
    const backlog = this.renderBacklog();
    const maxBatches = backlog >= RENDER_BACKLOG_LIGHT_LIMIT ? 1 : MAX_FETCH_BATCHES;
    const batchSize = backlog >= RENDER_BACKLOG_LIGHT_LIMIT ? Math.max(6, Math.floor(FETCH_BATCH_SIZE / 3)) : FETCH_BATCH_SIZE;
    const maxTier = this.ioTierLimit('fetch', backlog);
    while (this.fetching < maxBatches && this.fetchQueue.size > 0) {
      const keys = this.nextIoBatch(this.fetchQueue, batchSize, maxTier);
      if (!keys.length) break;
      for (const key of keys) this.fetchQueue.delete(key);
      void this.fetchBatch(keys);
    }
    if (this.fetchQueue.size > 0 && !this.fetchTimer) {
      this.fetchTimer = setTimeout(() => {
        this.fetchTimer = null;
        this.flushFetchQueue();
      }, 50);
    }
  }

  private sortKeys(keys: Iterable<string>): string[] {
    return [...keys].sort((a, b) => {
      const ap = this.priorityByKey.get(a) ?? { tier: 99, score: Infinity, updatedAt: 0 };
      const bp = this.priorityByKey.get(b) ?? { tier: 99, score: Infinity, updatedAt: 0 };
      return this.comparePriority(ap, bp);
    });
  }

  private nextIoBatch(queue: Set<string>, batchSize: number, maxTier: number): string[] {
    const out: string[] = [];
    for (const key of this.sortKeys(queue)) {
      const priority = this.priorityByKey.get(key) ?? { tier: 99, score: Infinity, updatedAt: 0 };
      if (priority.tier > maxTier) continue;
      out.push(key);
      if (out.length >= batchSize) break;
    }
    return out;
  }

  private ioTierLimit(kind: 'hash' | 'fetch', backlog: number): number {
    if (kind === 'fetch') {
      if (backlog >= RENDER_BACKLOG_HARD_LIMIT) return 2;
      if (backlog >= RENDER_BACKLOG_SOFT_LIMIT) return 3;
      if (backlog >= RENDER_BACKLOG_LIGHT_LIMIT) return 4;
      return 99;
    }
    if (backlog >= RENDER_BACKLOG_HARD_LIMIT) return 3;
    if (backlog >= RENDER_BACKLOG_SOFT_LIMIT) return 4;
    return 99;
  }

  private renderBacklog(): number {
    let waitingStored = 0;
    for (const e of this.chunks.values()) {
      if (e.state !== 'stored' || e.lastTier > 4) continue;
      if (e.displayed === 'none' || e.dirty || e.pendingFull || e.pendingLod) waitingStored++;
    }
    return this.meshQueue.size + this.activeMeshTasks + waitingStored;
  }

  private chunkBuffer(data: Uint8Array): ArrayBuffer {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }

  private handleFetchedHash(payload: ChunkHashPayload) {
    const key = this.key(payload.cx, payload.cz);
    const e = this.chunks.get(key);
    if (!e || (e.state !== 'checking' && e.state !== 'hashed' && e.state !== 'fetching')) return;
    if (!payload.hash || payload.missing) {
      e.state = 'absent';
      e.sourceHash = null;
      e.nbtHash = null;
      e.source = null;
      this.removeMesh(e);
      return;
    }
    if (e.sourceHash && e.sourceHash !== payload.hash) {
      this.removeMesh(e);
      this.send({ type: 'drop', key });
      e.displayedVersion = -1;
      e.dirty = false;
    }
    e.sourceHash = payload.hash;
    e.nbtHash = payload.nbtHash ?? null;
    e.source = payload.source ?? null;
    if (e.state !== 'fetching') e.state = 'hashed';
  }

  private async fetchHashBatch(keys: string[]) {
    const entries = keys
      .map((key) => this.chunks.get(key))
      .filter((e): e is ChunkEntry => !!e && e.state === 'checking');
    if (!entries.length) return;
    this.checking++;
    try {
      const seen = new Set<string>();
      const payloads = await fetchChunkHashes(this.opts.world, this.opts.dimension, entries.map((e) => ({ cx: e.cx, cz: e.cz })));
      for (const payload of payloads) {
        seen.add(this.key(payload.cx, payload.cz));
        this.handleFetchedHash(payload);
      }
      for (const e of entries) {
        if (!seen.has(this.key(e.cx, e.cz)) && e.state === 'checking') e.state = 'absent';
      }
    } catch {
      for (const e of entries) {
        if (e.state === 'checking') e.state = 'error';
      }
      this.reportStats();
    } finally {
      this.checking--;
      this.flushHashQueue();
    }
  }

  private handleFetchedChunk(payload: ChunkPayload) {
    const key = this.key(payload.cx, payload.cz);
    const e = this.chunks.get(key);
    if (!e || e.state !== 'fetching') return;
    if (!payload.data || payload.missing) {
      e.state = 'absent';
      return;
    }
    const sourceHash = payload.hash ?? payload.fileHash ?? null;
    if (!sourceHash) {
      e.state = 'error';
      return;
    }
    e.sourceHash = sourceHash;
    e.nbtHash = payload.nbtHash ?? null;
    e.source = payload.source ?? e.source;
    const chunk = this.chunkBuffer(payload.data);
    this.send({ type: 'chunk', key, cx: e.cx, cz: e.cz, dimension: this.opts.dimensionDef, chunk }, [chunk]);
  }

  private async fetchBatch(keys: string[]) {
    const entries = keys
      .map((key) => this.chunks.get(key))
      .filter((e): e is ChunkEntry => !!e && e.state === 'fetching');
    if (!entries.length) return;
    this.fetching++;
    try {
      const seen = new Set<string>();
      const payloads = await fetchChunks(this.opts.world, this.opts.dimension, entries.map((e) => ({ cx: e.cx, cz: e.cz })));
      for (const payload of payloads) {
        seen.add(this.key(payload.cx, payload.cz));
        this.handleFetchedChunk(payload);
      }
      for (const e of entries) {
        if (!seen.has(this.key(e.cx, e.cz)) && e.state === 'fetching') e.state = 'absent';
      }
    } catch {
      for (const e of entries) {
        if (e.state === 'fetching') e.state = 'error';
      }
      this.reportStats();
    } finally {
      this.fetching--;
      this.flushFetchQueue();
    }
  }

  private handleMessage(msg: WorkerResponse) {
    switch (msg.type) {
      case 'chunkReady': {
        const e = this.chunks.get(msg.key);
        if (!e) { this.send({ type: 'drop', key: msg.key }); return; }
        e.state = 'stored';
        e.biome = msg.biome;
        e.surfaceY = msg.surfaceY;
        // 邻居若已渲染需要重网格化（边界剔除/AO 才正确）
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dz) continue;
            const n = this.chunks.get(this.key(e.cx + dx, e.cz + dz));
            if (n && (n.displayed !== 'none' || n.pendingFull || n.pendingLod)) this.markDirty(n);
          }
        }
        this.scheduleStoredFromLastPriority(msg.key, e);
        this.flushMeshQueue();
        this.reportStats();
        break;
      }
      case 'chunkError': {
        const e = this.chunks.get(msg.key);
        if (e) e.state = 'error';
        console.warn('chunk parse error', msg.key, msg.error);
        break;
      }
      case 'meshResult': {
        this.finishActiveMesh(msg.version);
        const e = this.chunks.get(msg.key);
        const matched = e?.pendingFullVersion === msg.version;
        const cacheParts = matched ? e.pendingFullCacheParts : null;
        const dirtyToken = matched ? e.pendingFullDirtyToken : -1;
        if (!e || !matched) return;
        e.pendingFull = false;
        e.pendingFullCacheParts = null;
        const shouldDisplay = this.shouldApplyFullResult(e, msg.version);
        if (cacheParts) void putCachedFull(cacheParts, msg.sections).catch(() => { });
        if (!shouldDisplay) {
          this.rescheduleStoredIfFresh(msg.key, e);
          this.reportStats();
          return;
        }
        this.displayFull(e, msg.sections, msg.version);
        if (dirtyToken >= 0) this.clearDirtyIfUnchanged(e, dirtyToken);
        this.reportStats();
        break;
      }
      case 'lodResult': {
        this.finishActiveMesh(msg.version);
        const e = this.chunks.get(msg.key);
        let cacheParts: MeshCacheBaseParts | null = null;
        let dirtyToken = -1;
        if (e && e.pendingLodStep === msg.step && e.pendingLodVersion === msg.version) {
          cacheParts = e.pendingLodCacheParts;
          dirtyToken = e.pendingLodDirtyToken;
          e.pendingLod = false;
          e.pendingLodStep = 0;
          e.pendingLodCacheParts = null;
        }
        if (!e || dirtyToken < 0 || msg.version < e.displayedVersion) return;
        const step = (LOD_STEPS.includes(msg.step as LodStep) ? msg.step : 8) as LodStep;
        const shouldDisplay = this.shouldApplyLodResult(e, step, msg.version);
        if (cacheParts) void putCachedLod({ ...cacheParts, step }, msg.mesh).catch(() => { });
        if (!shouldDisplay) {
          this.rescheduleStoredIfFresh(msg.key, e);
          this.reportStats();
          return;
        }
        this.displayLod(e, msg.mesh, msg.version, step);
        if (dirtyToken >= 0) this.clearDirtyIfUnchanged(e, dirtyToken);
        this.reportStats();
        break;
      }
    }
  }

  private displayFull(e: ChunkEntry, sections: SectionMeshMsg[], version: number) {
    this.removeMesh(e);
    const group = new THREE.Group();
    for (const s of sections) {
      for (const [layer, buffers] of Object.entries(s.layers) as [RenderLayer, MeshBuffers][]) {
        const mesh = new THREE.Mesh(this.buildGeometry(buffers, true), this.materials[layer]);
        mesh.position.set(e.cx * 16, s.sy * 16, e.cz * 16);
        mesh.frustumCulled = true;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        group.add(mesh);
      }
    }
    this.root.add(group);
    e.group = group;
    e.displayed = 'full';
    e.displayedVersion = version;
    e.displayedLodStep = 0;
    this.reportStats();
  }

  private displayLod(e: ChunkEntry, meshBuffers: MeshBuffers | null, version: number, step: number) {
    this.removeMesh(e);
    if (meshBuffers) {
      const mesh = new THREE.Mesh(this.buildGeometry(meshBuffers, false), this.materials.lod);
      mesh.position.set(e.cx * 16, 0, e.cz * 16);
      mesh.frustumCulled = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      const group = new THREE.Group();
      group.add(mesh);
      this.root.add(group);
      e.group = group;
    }
    e.displayed = 'lod';
    e.displayedVersion = version;
    e.displayedLodStep = step;
    if (e.lastTargetStep === 1) {
      this.scheduleStoredFromLastPriority(this.key(e.cx, e.cz), e);
      this.flushMeshQueue();
    }
    this.reportStats();
  }

  private buildGeometry(b: MeshBuffers, sectionBounds: boolean): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(b.uvs, 2));
    g.setAttribute('tintColor', new THREE.BufferAttribute(b.colors, 3));
    g.setAttribute('lightData', new THREE.BufferAttribute(b.lights, 2));
    g.setIndex(new THREE.BufferAttribute(b.indices, 1));
    if (sectionBounds) {
      g.boundingBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(16, 16, 16));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(8, 8, 8), 16);
    } else {
      g.computeBoundingBox();
      g.computeBoundingSphere();
    }
    return g;
  }

  private removeMesh(e: ChunkEntry) {
    if (!e.group) return;
    this.root.remove(e.group);
    e.group.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    e.group = null;
    e.displayed = 'none';
    e.displayedLodStep = 0;
  }

  private reportStats() {
    let loaded = 0, rendered = 0;
    for (const e of this.chunks.values()) {
      if (e.state === 'stored') loaded++;
      if (e.group) rendered++;
    }
    this.onStats?.({ loaded, rendered });
  }

  dispose() {
    this.disposed = true;
    for (const e of this.chunks.values()) this.removeMesh(e);
    this.chunks.clear();
    this.hashQueue.clear();
    this.fetchQueue.clear();
    if (this.hashTimer) {
      clearTimeout(this.hashTimer);
      this.hashTimer = null;
    }
    if (this.fetchTimer) {
      clearTimeout(this.fetchTimer);
      this.fetchTimer = null;
    }
    this.scene.remove(this.root);
    this.worker.terminate();
  }
}
