import * as THREE from 'three';
import type { DimensionDef, MeshBuffers, RenderLayer } from '@violet-map/core';
import { fetchChunkHashes, fetchChunks, type ChunkHashPayload, type ChunkPayload } from '../api';
import { debugLog, isDebugLoggingEnabled } from '../logger';
import { chunkKey, type SectionMeshMsg, WorkerInit, WorkerRequest, WorkerResponse } from '../worker/protocol';
import { getCachedFull, getCachedLod, putCachedFull, putCachedLod, type MeshCacheKeyParts } from '../meshCache';
import type { TerrainMaterials } from './materials';
import {
  ChunkScheduler,
  LOD_STEPS,
  type ChunkProfileStats,
  type ChunkDiagnosticEvent,
  type ChunkDiagnosticOp,
  type ChunkRenderStats,
  type ChunkSchedulerCamera,
  type ChunkSchedulerEntry,
  type ChunkSchedulerStats,
  type ChunkState,
  type LodStep,
  type MeshTaskKind,
} from './chunkScheduler';

const UPDATE_INTERVAL_MS = 80;
const MAX_ACTIVE_MESH_TASKS = 4;
const DEFAULT_MAX_MESH_WORKERS = 2;
const ABSOLUTE_MAX_MESH_WORKERS = 4;
const WORKER_LIMIT_STORAGE_KEY = 'violet-map:maxMeshWorkers';
const DEFAULT_LOD_RELEASE_STEP: LodStep = 2;
const LOD_RELEASE_STEP_STORAGE_KEY = 'violet-map:lodReleaseStep';
const STALE_WORKER_RELEASE_MS = 4000;
const STALE_MESH_RELEASE_MS = 8000;
const WORKER_NEIGHBOR_HOLD_MS = 3500;
const MIN_WORKER_RESIDENT_COLUMNS = 192;
const MAX_WORKER_RESIDENT_COLUMNS = 1400;
const WORKER_RESIDENT_FULL_PADDING = 4;
const CHUNK_WORLD_MIN_Y = -80;
const CHUNK_WORLD_MAX_Y = 384;
const DIAGNOSTIC_HISTORY_LIMIT = 32;
const DIAGNOSTIC_MIN_SAMPLES = 8;
const DIAGNOSTIC_STDDEV_FACTOR = 3;
const DIAGNOSTIC_DELAY_CHECK_MS = 1000;
const DIAGNOSTIC_MIN_SLOW_MS: Record<ChunkDiagnosticOp, number> = {
  hashFetch: 450,
  chunkFetch: 900,
  parse: 90,
  fullMesh: 180,
  lodMesh: 120,
};
const DIAGNOSTIC_MIN_DELAY_MS: Record<ChunkDiagnosticOp, number> = {
  hashFetch: 1500,
  chunkFetch: 2500,
  parse: 0,
  fullMesh: 2500,
  lodMesh: 1800,
};
const SECTION_VISIBILITY_DIRS = ['down', 'up', 'north', 'south', 'west', 'east'] as const;
const SECTION_VISIBILITY_ALL = (() => {
  let mask = 0;
  for (let from = 0; from < 6; from++) {
    for (let to = 0; to < 6; to++) {
      if (from !== to) mask += 2 ** (from * 6 + to);
    }
  }
  return mask;
})();
const SECTION_NEIGHBOR: [number, number, number][] = [
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
  [-1, 0, 0],
  [1, 0, 0],
];
const SECTION_OPPOSITE = [1, 0, 3, 2, 5, 4] as const;
type MeshCacheBaseParts = Omit<MeshCacheKeyParts, 'mode' | 'step'>;

interface CachePartsResult {
  parts: MeshCacheBaseParts;
  stable: boolean;
}

export interface TopClipRange {
  minY: number;
  maxY: number;
}

type IoQueueKind = 'hash' | 'fetch';

interface ProfileSample {
  total: number;
  count: number;
  mean: number;
  m2: number;
}

interface ActiveDiagnosticOperation {
  id: number;
  op: Exclude<ChunkDiagnosticOp, 'parse'>;
  detail: string;
  startedAt: number;
  profile: ProfileSample;
  reportedDelayed: boolean;
}

function profileSample(): ProfileSample {
  return { total: 0, count: 0, mean: 0, m2: 0 };
}

function normalizeTopClipRange(range?: TopClipRange): TopClipRange {
  const minY = Number.isFinite(range?.minY) ? range!.minY : CHUNK_WORLD_MIN_Y;
  const maxY = Number.isFinite(range?.maxY) ? range!.maxY : CHUNK_WORLD_MAX_Y;
  return {
    minY: Math.max(CHUNK_WORLD_MIN_Y, Math.min(CHUNK_WORLD_MAX_Y, Math.min(minY, maxY))),
    maxY: Math.max(CHUNK_WORLD_MIN_Y, Math.min(CHUNK_WORLD_MAX_Y, Math.max(minY, maxY))),
  };
}

interface FullSectionRender {
  key: string;
  cx: number;
  sy: number;
  cz: number;
  visibility: number;
  meshes: THREE.Mesh[];
}

interface ChunkEntry extends ChunkSchedulerEntry {
  workerReadyMask: number;
  workerKeepUntil: number;
  pendingFullVersion: number;
  pendingLodVersion: number;
  pendingFullCacheParts: MeshCacheBaseParts | null;
  pendingLodCacheParts: MeshCacheBaseParts | null;
  pendingFullDirtyToken: number;
  pendingLodDirtyToken: number;
  lodReadyStep: number;
  fullReady: boolean;
  dirtyToken: number;
  group: THREE.Group | null;
  fullSections: FullSectionRender[];
  meshBytes: number;
  biome: string;
  surfaceY: number;
  sourceHash: string | null;
  nbtHash: string | null;
  source: 'region' | 'chunk' | null;
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
  private workers: Worker[] = [];
  private workerLoads: number[] = [];
  private versionWorker = new Map<number, number>();
  private chunks = new Map<string, ChunkEntry>();
  private fullSectionIndex = new Map<string, FullSectionRender>();
  private scheduler: ChunkScheduler;
  private checking = 0;
  private hashTimer: ReturnType<typeof setTimeout> | null = null;
  private fetching = 0;
  private fetchTimer: ReturnType<typeof setTimeout> | null = null;
  private deferredMeshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private activeMeshTasks = 0;
  private inFlightMeshVersions = new Set<number>();
  private versionCounter = 0;
  private hashFetchProfile = profileSample();
  private chunkFetchProfile = profileSample();
  private parseProfile = profileSample();
  private fullMeshProfile = profileSample();
  private lodMeshProfile = profileSample();
  private diagnostics: ChunkDiagnosticEvent[] = [];
  private diagnosticSeq = 0;
  private activeDiagnostics = new Map<number, ActiveDiagnosticOperation>();
  private meshDiagnosticByVersion = new Map<number, number>();
  private activeDiagnosticSeq = 0;
  private lastDiagnosticDelayCheck = 0;
  private chunkBytesFetched = 0;
  private displayedMeshBytes = 0;
  private fullCacheHits = 0;
  private fullCacheMisses = 0;
  private lodCacheHits = 0;
  private lodCacheMisses = 0;
  private schedulerStats: ChunkSchedulerStats = {
    nbt: 0,
    lodReady: 0,
    lodRendered: 0,
    fullReady: 0,
    fullRendered: 0,
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
    hashQueued: 0,
    fetchQueued: 0,
    meshQueued: 0,
    trackedPriorities: 0,
  };
  private lastUpdate = 0;
  private lodReleaseStep: LodStep = DEFAULT_LOD_RELEASE_STEP;
  private disposed = false;
  private topDownView = false;
  private topClipRange: TopClipRange = { minY: CHUNK_WORLD_MIN_Y, maxY: CHUNK_WORLD_MAX_Y };
  readonly root = new THREE.Group();
  onStats?: (s: ChunkSchedulerStats) => void;

  // #region Lifecycle

  constructor(
    private scene: THREE.Scene,
    private materials: TerrainMaterials,
    private initPayload: Omit<WorkerInit, 'type'>,
    public opts: ChunkManagerOptions,
  ) {
    this.scheduler = new ChunkScheduler({ viewDistance: opts.viewDistance, lodDistance: opts.lodDistance });
    this.root.matrixAutoUpdate = false;
    this.root.updateMatrix();
    scene.add(this.root);
    this.lodReleaseStep = this.resolveLodReleaseStep();
    const workerCount = this.resolveWorkerCount();
    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(new URL('../worker/meshWorker.ts', import.meta.url), { type: 'module' });
      worker.postMessage({ type: 'init', ...initPayload } satisfies WorkerInit);
      worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.handleMessage(ev.data, i);
      this.workers.push(worker);
      this.workerLoads.push(0);
    }
  }

  // #endregion

  // #region Keys and workers

  private resolveWorkerCount(): number {
    const hardware = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
    const hardwareLimit = hardware > 2 ? hardware - 1 : 1;
    const memory = typeof navigator !== 'undefined'
      ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory
      : undefined;
    const defaultLimit = memory !== undefined && memory <= 4 ? 1 : DEFAULT_MAX_MESH_WORKERS;
    let requested = defaultLimit;
    try {
      const raw = localStorage.getItem(WORKER_LIMIT_STORAGE_KEY);
      const stored = raw === null ? NaN : Number(raw);
      if (Number.isFinite(stored)) requested = stored;
    } catch {
      // Local storage can be unavailable in private or restricted contexts.
    }
    return Math.max(1, Math.min(ABSOLUTE_MAX_MESH_WORKERS, hardwareLimit, Math.floor(requested)));
  }

  private resolveLodReleaseStep(): LodStep {
    try {
      const raw = localStorage.getItem(LOD_RELEASE_STEP_STORAGE_KEY);
      const stored = raw === null ? NaN : Number(raw);
      if (LOD_STEPS.includes(stored as LodStep) && stored > 1) return stored as LodStep;
    } catch {
      // Local storage can be unavailable in private or restricted contexts.
    }
    return DEFAULT_LOD_RELEASE_STEP;
  }

  private key(cx: number, cz: number) { return chunkKey(this.opts.world, this.opts.dimension, cx, cz); }
  private sectionKey(cx: number, sy: number, cz: number) { return `${cx},${sy},${cz}`; }
  private allWorkersMask(): number {
    return (1 << Math.max(1, this.workers.length)) - 1;
  }
  private sendToWorker(workerIndex: number, msg: WorkerRequest, transfer: Transferable[] = []) {
    this.workers[workerIndex]?.postMessage(msg, transfer);
  }
  private broadcast(msg: WorkerRequest) {
    for (const worker of this.workers) worker.postMessage(msg);
  }
  private sendChunkToWorkers(msg: Omit<Extract<WorkerRequest, { type: 'chunk' }>, 'chunk'>, chunk: ArrayBuffer) {
    const last = this.workers.length - 1;
    for (let i = 0; i < this.workers.length; i++) {
      const copy = i === last ? chunk : chunk.slice(0);
      this.workers[i].postMessage({ ...msg, chunk: copy } satisfies WorkerRequest, [copy]);
    }
  }

  // #endregion

  // #region Public queries

  biomeAt(cx: number, cz: number): string | null {
    const e = this.chunks.get(this.key(cx, cz));
    return e && e.state !== 'absent' && e.state !== 'error' && e.displayed !== 'none' ? e.biome : null;
  }
  surfaceYAt(cx: number, cz: number): number | null {
    const e = this.chunks.get(this.key(cx, cz));
    return e && e.state !== 'absent' && e.state !== 'error' && e.displayed !== 'none' ? e.surfaceY : null;
  }

  displayedChunkKeys(): Set<string> {
    const out = new Set<string>();
    for (const e of this.chunks.values()) {
      if (e.displayed === 'none' || !this.entryHasDisplayedMesh(e)) continue;
      out.add(`${e.cx},${e.cz}`);
    }
    return out;
  }

  // #endregion

  // #region Scheduler bridge

  private schedulerEntryForKey(key: string): ChunkSchedulerEntry | null {
    return this.chunks.get(key) ?? null;
  }

  private schedulerEntries(): Iterable<ChunkSchedulerEntry> {
    return this.chunks.values();
  }

  /** 每帧调用（内部节流）。 */
  update(
    camera: ChunkSchedulerCamera,
    now: number,
    force = false,
    viewportHeight = window.innerHeight,
    topDownView = false,
    topClipRange?: TopClipRange,
    lodDistanceOverride?: number,
  ) {
    const nextTopClipRange = normalizeTopClipRange(topClipRange);
    const clipChanged = nextTopClipRange.minY !== this.topClipRange.minY || nextTopClipRange.maxY !== this.topClipRange.maxY;
    const viewChanged = this.topDownView !== topDownView;
    if (viewChanged || clipChanged) {
      this.topDownView = topDownView;
      this.topClipRange = nextTopClipRange;
      if (viewChanged) this.setMeshFrustumCulled(!topDownView);
      this.applyTopClipVisibility();
    }
    if (!force && now - this.lastUpdate < UPDATE_INTERVAL_MS) return;
    this.lastUpdate = now;

    this.scheduler.setOptions({
      viewDistance: this.opts.viewDistance,
      lodDistance: lodDistanceOverride ?? this.opts.lodDistance,
    });
    const entriesBefore = this.chunks.size;
    const frame = this.scheduler.planFrame(
      camera,
      now,
      force,
      viewportHeight,
      (cx, cz) => this.key(cx, cz),
      (key) => this.schedulerEntryForKey(key),
      topDownView,
    );

    for (const candidate of frame.candidates) {
      const e = this.ensureEntry(candidate.cx, candidate.cz, now);
      e.lastWantedAt = now;
      e.lastTier = candidate.tier;
      e.lastScore = candidate.score;
      e.lastTargetStep = candidate.targetStep;
      e.lastForcedFull = candidate.forcedFull;
      const decision = this.scheduler.scheduleCandidate(candidate, e);
      if (decision.removeMesh) this.removeMesh(e);
    }

    this.scheduler.pruneQueues(frame.keepKeys, now);
    this.scheduler.expirePriorities(now);
    const evictedKeys = this.scheduler.evictKeys(frame.centerCx, frame.centerCz, frame.keepKeys, this.schedulerEntries(), now);
    for (const key of evictedKeys) {
      const e = this.chunks.get(key);
      if (e) this.dropEntry(key, e);
    }
    this.releaseStaleEntries(frame.keepKeys, now);
    this.releaseDisplayedWorkerData();
    this.releaseWorkerDataOverBudget();
    this.checkDelayedOperations(now);
    this.syncSchedulerStats();
    this.flushMeshQueue();
    this.flushHashQueue();
    this.flushFetchQueue();
    this.flushMeshQueue();
    this.updateFullSectionVisibility(camera);
    if (isDebugLoggingEnabled()) {
      debugLog('chunk-manager', 'update', {
        world: this.opts.world,
        dimension: this.opts.dimension,
        topDownView,
        topClipRange: this.topClipRange,
        candidates: frame.candidates.length,
        keepKeys: frame.keepKeys.size,
        entriesBefore,
        entriesAfter: this.chunks.size,
        evicted: evictedKeys.length,
        stats: this.schedulerStats,
      });
    }
    this.reportStats();
  }

  // #endregion

  // #region Entry creation and scheduling

  private ensureEntry(cx: number, cz: number, now: number): ChunkEntry {
    const key = this.key(cx, cz);
    let e = this.chunks.get(key);
    if (e) return e;
    e = {
      key,
      cx, cz,
      state: 'checking',
      workerReadyMask: 0,
      workerKeepUntil: 0,
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
      lodReadyStep: 0,
      fullReady: false,
      dirty: false,
      dirtyToken: 0,
      group: null,
      fullSections: [],
      meshBytes: 0,
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

  private rescheduleStoredIfFresh(e: ChunkEntry) {
    const now = performance.now();
    if (!this.scheduler.priorityFresh(e, now)) return;
    this.scheduler.scheduleStoredFromLastPriority(e, now);
    this.flushMeshQueue();
  }

  // #endregion

  // #region Mesh task lifecycle

  private flushMeshQueue() {
    while (this.activeMeshTasks < this.maxActiveMeshTasks()) {
      const task = this.scheduler.nextMeshTask((key) => this.schedulerEntryForKey(key), this.schedulerEntries(), performance.now());
      if (!task) return;
      const e = this.chunks.get(task.key);
      if (!e || e.state !== 'stored') continue;
      if (task.kind === 'full') {
        if (e.displayed === 'full' && !e.dirty) continue;
        if (e.pendingFull) continue;
        this.requestFull(e);
      } else {
        if (e.displayed === 'lod' && e.displayedLodStep === task.step && !e.dirty) continue;
        if (e.pendingLod && e.pendingLodStep === task.step) continue;
        this.requestLod(e, task.step);
      }
    }
  }

  private maxActiveMeshTasks(): number {
    return Math.max(1, Math.min(MAX_ACTIVE_MESH_TASKS, this.workers.length || 1));
  }

  private finishActiveMesh(version?: number) {
    if (version !== undefined) {
      if (!this.inFlightMeshVersions.delete(version)) return;
      const workerIndex = this.versionWorker.get(version);
      if (workerIndex !== undefined) {
        this.workerLoads[workerIndex] = Math.max(0, (this.workerLoads[workerIndex] ?? 0) - 1);
        this.versionWorker.delete(version);
      }
    }
    this.activeMeshTasks = Math.max(0, this.activeMeshTasks - 1);
    this.flushMeshQueue();
  }

  private markWorkerMesh(version: number): number {
    this.inFlightMeshVersions.add(version);
    let best = 0;
    for (let i = 1; i < this.workerLoads.length; i++) {
      if ((this.workerLoads[i] ?? 0) < (this.workerLoads[best] ?? 0)) best = i;
    }
    this.workerLoads[best] = (this.workerLoads[best] ?? 0) + 1;
    this.versionWorker.set(version, best);
    return best;
  }

  private requeueMesh(e: ChunkEntry, kind: MeshTaskKind, step: LodStep, fallbackTier: number) {
    const priority = this.scheduler.priorityFor(e.key, { tier: fallbackTier, score: 0, updatedAt: performance.now() });
    this.scheduler.enqueueMeshTask({ key: e.key, kind, step, ...priority });
  }

  private deferMesh(e: ChunkEntry, kind: MeshTaskKind, step: LodStep, fallbackTier: number) {
    const timerKey = `${e.key}\u0000${kind}`;
    if (this.deferredMeshTimers.has(timerKey)) return;
    const timer = setTimeout(() => {
      this.deferredMeshTimers.delete(timerKey);
      if (this.disposed) return;
      const current = this.chunks.get(e.key);
      if (!current || current.state !== 'stored') return;
      this.requeueMesh(current, kind, step, fallbackTier);
      this.flushMeshQueue();
    }, 80);
    this.deferredMeshTimers.set(timerKey, timer);
  }

  private beginPendingMesh(e: ChunkEntry, kind: MeshTaskKind, step: LodStep, cache: CachePartsResult): number {
    this.activeMeshTasks++;
    const version = ++this.versionCounter;
    if (kind === 'full') {
      e.pendingFull = true;
      e.pendingFullCacheParts = cache.stable ? cache.parts : null;
      e.pendingFullDirtyToken = e.dirtyToken;
      e.pendingFullVersion = version;
    } else {
      e.pendingLod = true;
      e.pendingLodStep = step;
      e.pendingLodCacheParts = cache.stable ? cache.parts : null;
      e.pendingLodDirtyToken = e.dirtyToken;
      e.pendingLodVersion = version;
    }
    return version;
  }

  private clearPendingMesh(e: ChunkEntry, kind: MeshTaskKind) {
    if (kind === 'full') {
      e.pendingFull = false;
      e.pendingFullCacheParts = null;
      return;
    }
    e.pendingLod = false;
    e.pendingLodStep = 0;
    e.pendingLodCacheParts = null;
  }

  private recoverMissingWorkerInput(e: ChunkEntry, kind: MeshTaskKind, step: LodStep) {
    if (e.state === 'stored') {
      e.workerReadyMask = 0;
      e.state = 'hashed';
    }
    if (e.state === 'checking') this.queueHash(e.key);
    else if (e.state === 'hashed') this.queueFetch(e.key);
    else if (e.state === 'fetching') this.flushFetchQueue();
    this.deferMesh(e, kind, step, kind === 'full' ? 3 : 4);
    this.reportStats();
  }

  private shouldApplyMeshResult(e: ChunkEntry, kind: MeshTaskKind, step: LodStep, version: number): boolean {
    const now = performance.now();
    return kind === 'full'
      ? this.scheduler.shouldApplyFullResult(e, version, now)
      : this.scheduler.shouldApplyLodResult(e, step, version, now);
  }

  private startWorkerMeshing(e: ChunkEntry, kind: MeshTaskKind, step: LodStep, version: number) {
    if (e.state !== 'stored') {
      this.clearPendingMesh(e, kind);
      this.queueFetch(e.key);
      this.finishActiveMesh();
      return;
    }
    if (!this.shouldApplyMeshResult(e, kind, step, version)) {
      this.clearPendingMesh(e, kind);
      this.finishActiveMesh();
      this.rescheduleStoredIfFresh(e);
      return;
    }
    const workerIndex = this.markWorkerMesh(version);
    const op = kind === 'full' ? 'fullMesh' : 'lodMesh';
    const profile = kind === 'full' ? this.fullMeshProfile : this.lodMeshProfile;
    const detail = kind === 'full' ? e.key : `${e.key} LOD ${step}`;
    this.meshDiagnosticByVersion.set(version, this.beginActiveOperation(op, detail, profile));
    if (kind === 'full') this.sendToWorker(workerIndex, { type: 'mesh', key: e.key, version });
    else this.sendToWorker(workerIndex, { type: 'lod', key: e.key, step, version });
  }

  // #endregion

  // #region Chunk state and cache keys

  private dropEntry(key: string, e: ChunkEntry) {
    this.removeMesh(e);
    if (e.state === 'stored' || e.state === 'decoding') this.broadcast({ type: 'drop', key });
    this.chunks.delete(key);
    this.scheduler.deleteKey(key);
  }

  private cacheParts(e: ChunkEntry): MeshCacheBaseParts {
    const contentHash = this.contentHash(e);
    if (!contentHash) throw new Error(`missing content hash for mesh cache key: ${e.key}`);
    return {
      world: this.opts.world,
      dimension: this.opts.dimension,
      renderKey: this.opts.renderKey,
      cx: e.cx,
      cz: e.cz,
      contentKey: contentHash,
    };
  }

  private contentHash(e: ChunkEntry): string | null {
    return e.nbtHash ?? e.sourceHash;
  }

  private payloadContentHash(payload: Pick<ChunkHashPayload, 'hash' | 'fileHash' | 'nbtHash'>): string | null {
    return payload.nbtHash ?? payload.hash ?? payload.fileHash ?? null;
  }

  private invalidatePendingMeshes(e: ChunkEntry) {
    e.pendingFull = false;
    e.pendingLod = false;
    e.pendingLodStep = 0;
    e.pendingFullCacheParts = null;
    e.pendingLodCacheParts = null;
    e.pendingFullVersion = -1;
    e.pendingLodVersion = -1;
  }

  private markDirty(e: ChunkEntry) {
    e.dirty = true;
    e.dirtyToken++;
  }

  private clearDirtyIfUnchanged(e: ChunkEntry, dirtyToken: number) {
    if (e.dirtyToken === dirtyToken) e.dirty = false;
  }

  private markNeighborsDirty(e: ChunkEntry) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const n = this.chunks.get(this.key(e.cx + dx, e.cz + dz));
        if (n && (n.displayed !== 'none' || n.pendingFull || n.pendingLod)) this.markDirty(n);
      }
    }
  }

  private neighborhoodCacheParts(e: ChunkEntry): CachePartsResult | null {
    if (!this.contentHash(e)) return null;
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
        else if (n.state === 'stored' && this.contentHash(n)) parts.push(`hash:${this.contentHash(n)}`);
        else {
          parts.push('unknown');
          stable = false;
        }
      }
    }
    return { parts: { ...this.cacheParts(e), contentKey: JSON.stringify(parts) }, stable };
  }

  private keepWorkerData(e: ChunkEntry, now: number) {
    e.workerKeepUntil = Math.max(e.workerKeepUntil, now + WORKER_NEIGHBOR_HOLD_MS);
  }

  private neighborNeedsWorkerData(center: ChunkEntry, candidate: ChunkEntry): boolean {
    return candidate === center
      || candidate.state === 'stored'
      || candidate.displayed !== 'none'
      || candidate.pendingFull
      || candidate.pendingLod;
  }

  private ensureNeighborhoodWorkerData(e: ChunkEntry, now: number): boolean {
    let ready = true;
    const fetchKeys: string[] = [];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = this.chunks.get(this.key(e.cx + dx, e.cz + dz));
        if (!n || n.state === 'absent' || n.state === 'error') continue;
        if (!this.neighborNeedsWorkerData(e, n)) continue;
        this.keepWorkerData(n, now);
        if (n.state === 'stored') continue;
        ready = false;
        if (n.state === 'checking') this.queueHash(n.key);
        else if (n.state === 'hashed') fetchKeys.push(n.key);
      }
    }
    if (fetchKeys.length) void this.fetchBatch(fetchKeys);
    return ready;
  }

  // #endregion

  // #region Mesh requests

  private requestFull(e: ChunkEntry) {
    if (this.activeMeshTasks >= this.maxActiveMeshTasks()) {
      this.requeueMesh(e, 'full', 1, 3);
      return;
    }
    const now = performance.now();
    if (!this.ensureNeighborhoodWorkerData(e, now)) {
      this.deferMesh(e, 'full', 1, 3);
      this.flushHashQueue();
      this.flushFetchQueue();
      return;
    }
    const cache = this.neighborhoodCacheParts(e);
    if (!cache) {
      this.queueHash(e.key);
      return;
    }
    const version = this.beginPendingMesh(e, 'full', 1, cache);
    if (!cache.stable) {
      this.startWorkerMeshing(e, 'full', 1, version);
      return;
    }
    void getCachedFull(cache.parts).then((hit) => {
      if (this.disposed) { this.finishActiveMesh(); return; }
      const current = this.chunks.get(e.key);
      if (!current || current.pendingFullVersion !== version) {
        this.finishActiveMesh();
        return;
      }
      if (hit) {
        this.fullCacheHits++;
        this.clearPendingMesh(current, 'full');
        this.finishActiveMesh();
        if (!this.shouldApplyMeshResult(current, 'full', 1, version)) {
          this.rescheduleStoredIfFresh(current);
          return;
        }
        this.displayFull(current, hit, version);
        this.clearDirtyIfUnchanged(current, current.pendingFullDirtyToken);
        return;
      }
      this.fullCacheMisses++;
      this.startWorkerMeshing(current, 'full', 1, version);
    }).catch(() => {
      const current = this.chunks.get(e.key);
      if (current?.pendingFullVersion === version) {
        this.clearPendingMesh(current, 'full');
        if (current.state !== 'stored') this.queueFetch(current.key);
      }
      this.finishActiveMesh();
    });
  }

  private requestLod(e: ChunkEntry, step: LodStep) {
    if (this.activeMeshTasks >= this.maxActiveMeshTasks()) {
      this.requeueMesh(e, 'lod', step, 4);
      return;
    }
    if (!this.contentHash(e)) {
      this.queueHash(e.key);
      return;
    }
    if (e.state !== 'stored') {
      this.queueFetch(e.key);
      return;
    }
    const now = performance.now();
    if (!this.ensureNeighborhoodWorkerData(e, now)) {
      this.deferMesh(e, 'lod', step, 4);
      this.flushHashQueue();
      this.flushFetchQueue();
      return;
    }
    const cache = this.neighborhoodCacheParts(e);
    if (!cache) {
      this.queueHash(e.key);
      return;
    }
    const version = this.beginPendingMesh(e, 'lod', step, cache);
    if (!cache.stable) {
      this.startWorkerMeshing(e, 'lod', step, version);
      return;
    }
    void getCachedLod({ ...cache.parts, step }).then((hit) => {
      if (this.disposed) { this.finishActiveMesh(); return; }
      const current = this.chunks.get(e.key);
      if (!current || current.pendingLodVersion !== version || current.pendingLodStep !== step) {
        this.finishActiveMesh();
        return;
      }
      if (hit !== undefined) {
        this.lodCacheHits++;
        this.clearPendingMesh(current, 'lod');
        this.finishActiveMesh();
        if (!this.shouldApplyMeshResult(current, 'lod', step, version)) {
          this.rescheduleStoredIfFresh(current);
          return;
        }
        this.displayLod(current, hit, version, step);
        this.clearDirtyIfUnchanged(current, current.pendingLodDirtyToken);
        this.maybeReleaseDisplayedLodData(current);
        this.reportStats();
        return;
      }
      this.lodCacheMisses++;
      this.startWorkerMeshing(current, 'lod', step, version);
    }).catch(() => {
      const current = this.chunks.get(e.key);
      if (current?.pendingLodVersion === version && current.pendingLodStep === step) {
        this.clearPendingMesh(current, 'lod');
        if (current.state !== 'stored') this.queueFetch(current.key);
      }
      this.finishActiveMesh();
    });
  }

  // #endregion

  // #region IO queues

  private queueHash(key: string) {
    this.queueIo('hash', key);
  }

  private flushHashQueue() {
    this.flushIoQueue('hash');
  }

  private queueFetch(key: string) {
    this.queueIo('fetch', key);
  }

  private flushFetchQueue() {
    this.flushIoQueue('fetch');
  }

  private queueIo(kind: IoQueueKind, key: string) {
    const e = this.chunks.get(key);
    if (kind === 'fetch' && e && e.state !== 'stored') e.state = 'fetching';
    if (kind === 'hash') this.scheduler.enqueueHash(key);
    else this.scheduler.enqueueFetch(key);
    this.scheduleIoFlush(kind, 20);
  }

  private flushIoQueue(kind: IoQueueKind) {
    while (true) {
      const keys = this.nextIoBatch(kind);
      if (!keys.length) break;
      if (kind === 'hash') void this.fetchHashBatch(keys);
      else void this.fetchBatch(keys);
    }
    if (this.hasIoWork(kind)) this.scheduleIoFlush(kind, 50);
  }

  private nextIoBatch(kind: IoQueueKind): string[] {
    return kind === 'hash'
      ? this.scheduler.nextHashBatch(this.checking, this.schedulerEntries(), this.activeMeshTasks)
      : this.scheduler.nextFetchBatch(this.fetching, this.schedulerEntries(), this.activeMeshTasks);
  }

  private hasIoWork(kind: IoQueueKind): boolean {
    return kind === 'hash' ? this.scheduler.hasHashWork : this.scheduler.hasFetchWork;
  }

  private scheduleIoFlush(kind: IoQueueKind, delayMs: number) {
    if (this.ioTimer(kind)) return;
    this.setIoTimer(kind, setTimeout(() => {
      this.setIoTimer(kind, null);
      this.flushIoQueue(kind);
    }, delayMs));
  }

  private ioTimer(kind: IoQueueKind): ReturnType<typeof setTimeout> | null {
    return kind === 'hash' ? this.hashTimer : this.fetchTimer;
  }

  private setIoTimer(kind: IoQueueKind, timer: ReturnType<typeof setTimeout> | null) {
    if (kind === 'hash') this.hashTimer = timer;
    else this.fetchTimer = timer;
  }

  // #endregion

  // #region Fetch handling

  private sample(profile: ProfileSample, value: number | undefined) {
    if (value === undefined || !Number.isFinite(value) || value < 0) return;
    profile.total += value;
    profile.count++;
    const delta = value - profile.mean;
    profile.mean += delta / profile.count;
    profile.m2 += delta * (value - profile.mean);
  }

  private average(profile: ProfileSample): number {
    return profile.count > 0 ? profile.total / profile.count : 0;
  }

  private stddev(profile: ProfileSample): number {
    return profile.count > 1 ? Math.sqrt(profile.m2 / (profile.count - 1)) : 0;
  }

  private slowThreshold(op: ChunkDiagnosticOp, profile: ProfileSample): number {
    if (profile.count < DIAGNOSTIC_MIN_SAMPLES) return Infinity;
    return Math.max(DIAGNOSTIC_MIN_SLOW_MS[op], profile.mean + this.stddev(profile) * DIAGNOSTIC_STDDEV_FACTOR);
  }

  private delayThreshold(op: Exclude<ChunkDiagnosticOp, 'parse'>, profile: ProfileSample): number {
    if (profile.count < DIAGNOSTIC_MIN_SAMPLES) return DIAGNOSTIC_MIN_DELAY_MS[op];
    return Math.max(DIAGNOSTIC_MIN_DELAY_MS[op], profile.mean + this.stddev(profile) * DIAGNOSTIC_STDDEV_FACTOR);
  }

  private addDiagnostic(
    kind: ChunkDiagnosticEvent['kind'],
    op: ChunkDiagnosticOp,
    detail: string,
    durationMs: number,
    thresholdMs: number,
    sampleCount: number,
  ) {
    this.diagnostics.unshift({
      id: ++this.diagnosticSeq,
      time: Date.now(),
      kind,
      op,
      detail,
      durationMs,
      thresholdMs,
      sampleCount,
    });
    if (this.diagnostics.length > DIAGNOSTIC_HISTORY_LIMIT) this.diagnostics.length = DIAGNOSTIC_HISTORY_LIMIT;
  }

  private recordCompletedOperation(
    op: ChunkDiagnosticOp,
    profile: ProfileSample,
    durationMs: number | undefined,
    detail: string,
  ) {
    if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return;
    const threshold = this.slowThreshold(op, profile);
    const sampleCount = profile.count;
    if (durationMs > threshold) this.addDiagnostic('slow', op, detail, durationMs, threshold, sampleCount);
    this.sample(profile, durationMs);
  }

  private beginActiveOperation(
    op: Exclude<ChunkDiagnosticOp, 'parse'>,
    detail: string,
    profile: ProfileSample,
  ): number {
    const id = ++this.activeDiagnosticSeq;
    this.activeDiagnostics.set(id, {
      id,
      op,
      detail,
      profile,
      startedAt: performance.now(),
      reportedDelayed: false,
    });
    return id;
  }

  private finishActiveOperation(id: number, durationMs?: number) {
    const op = this.activeDiagnostics.get(id);
    if (!op) return;
    this.activeDiagnostics.delete(id);
    const duration = durationMs ?? performance.now() - op.startedAt;
    if (op.reportedDelayed) this.sample(op.profile, duration);
    else this.recordCompletedOperation(op.op, op.profile, duration, op.detail);
  }

  private finishMeshDiagnostic(version: number, durationMs: number | undefined) {
    const opId = this.meshDiagnosticByVersion.get(version);
    if (opId === undefined) return;
    this.meshDiagnosticByVersion.delete(version);
    this.finishActiveOperation(opId, durationMs);
  }

  private checkDelayedOperations(now: number) {
    if (now - this.lastDiagnosticDelayCheck < DIAGNOSTIC_DELAY_CHECK_MS) return;
    this.lastDiagnosticDelayCheck = now;
    for (const op of this.activeDiagnostics.values()) {
      if (op.reportedDelayed) continue;
      const duration = now - op.startedAt;
      const threshold = this.delayThreshold(op.op, op.profile);
      if (duration <= threshold) continue;
      op.reportedDelayed = true;
      this.addDiagnostic('delayed', op.op, op.detail, duration, threshold, op.profile.count);
    }
  }

  private chunkBuffer(data: Uint8Array): ArrayBuffer {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }

  private clearReadyFlags(e: ChunkEntry) {
    e.lodReadyStep = 0;
    e.fullReady = false;
  }

  private markUnavailable(
    e: ChunkEntry,
    state: Extract<ChunkState, 'absent' | 'error'>,
    clearSource = false,
    removeMesh = true,
  ) {
    e.state = state;
    if (clearSource) {
      e.sourceHash = null;
      e.nbtHash = null;
      e.source = null;
    }
    this.clearReadyFlags(e);
    this.invalidatePendingMeshes(e);
    this.markNeighborsDirty(e);
    if (removeMesh) this.removeMesh(e);
  }

  private resetAfterSourceChange(e: ChunkEntry) {
    this.removeMesh(e);
    this.broadcast({ type: 'drop', key: e.key });
    this.invalidatePendingMeshes(e);
    this.markNeighborsDirty(e);
    e.displayedVersion = -1;
    e.dirty = false;
    this.clearReadyFlags(e);
  }

  private maybeReleaseDisplayedLodData(e: ChunkEntry) {
    if (e.state !== 'stored') return;
    if (e.displayed !== 'lod' || e.lastTargetStep === 1 || e.dirty) return;
    if (e.displayedLodStep < this.lodReleaseStep) return;
    if (e.pendingFull || e.pendingLod || !this.contentHash(e)) return;
    this.releaseWorkerData(e);
  }

  private maybeReleaseDisplayedFullData(e: ChunkEntry) {
    if (e.state !== 'stored') return;
    if (e.displayed !== 'full' || e.dirty) return;
    if (e.pendingFull || e.pendingLod || !this.contentHash(e)) return;
    this.releaseWorkerData(e);
  }

  private releaseDisplayedWorkerData() {
    for (const e of this.chunks.values()) {
      this.maybeReleaseDisplayedLodData(e);
      this.maybeReleaseDisplayedFullData(e);
    }
  }

  private releaseWorkerData(e: ChunkEntry): boolean {
    if (e.state !== 'stored') return false;
    if (performance.now() < e.workerKeepUntil) return false;
    if (e.pendingFull || e.pendingLod || !this.contentHash(e)) return false;
    this.broadcast({ type: 'drop', key: e.key });
    e.workerReadyMask = 0;
    e.state = 'hashed';
    return true;
  }

  private displaySatisfiesLastTarget(e: ChunkEntry): boolean {
    if (e.dirty || e.displayed === 'none') return false;
    if (e.lastTargetStep === 1) return e.displayed === 'full';
    if (e.displayed === 'full') return true;
    return e.displayed === 'lod' && e.displayedLodStep > 0 && e.displayedLodStep <= e.lastTargetStep;
  }

  private maxWorkerResidentColumns(): number {
    const radius = Math.max(4, Math.floor(this.opts.viewDistance) + WORKER_RESIDENT_FULL_PADDING);
    const target = (radius * 2 + 1) ** 2;
    return Math.max(MIN_WORKER_RESIDENT_COLUMNS, Math.min(MAX_WORKER_RESIDENT_COLUMNS, target));
  }

  private releaseWorkerDataOverBudget() {
    const resident = [...this.chunks.values()].filter((e) => e.state === 'stored');
    const budget = this.maxWorkerResidentColumns();
    if (resident.length <= budget) return;
    const victims = resident
      .filter((e) => !e.pendingFull && !e.pendingLod && this.displaySatisfiesLastTarget(e) && !!this.contentHash(e))
      .sort((a, b) => b.lastTier - a.lastTier || a.lastWantedAt - b.lastWantedAt || b.lastScore - a.lastScore);
    let count = resident.length;
    for (const e of victims) {
      if (count <= budget) break;
      if (this.releaseWorkerData(e)) count--;
    }
  }

  private releaseStaleEntries(keepKeys: Set<string>, now: number) {
    for (const e of this.chunks.values()) {
      if (keepKeys.has(e.key)) continue;
      const age = now - e.lastWantedAt;
      if (age > STALE_WORKER_RELEASE_MS) this.releaseWorkerData(e);
      if (age > STALE_MESH_RELEASE_MS && e.displayed !== 'none') this.removeMesh(e);
    }
  }

  private handleFetchedHash(payload: ChunkHashPayload) {
    const key = this.key(payload.cx, payload.cz);
    const e = this.chunks.get(key);
    if (!e || (e.state !== 'checking' && e.state !== 'hashed' && e.state !== 'fetching')) return;
    if (!payload.hash || payload.missing) {
      this.markUnavailable(e, 'absent', true);
      return;
    }
    const oldContentHash = this.contentHash(e);
    const newContentHash = this.payloadContentHash(payload);
    if (oldContentHash && newContentHash && oldContentHash !== newContentHash) {
      this.resetAfterSourceChange(e);
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
    const started = performance.now();
    const opId = this.beginActiveOperation('hashFetch', `${entries.length} hashes`, this.hashFetchProfile);
    try {
      const seen = new Set<string>();
      const payloads = await fetchChunkHashes(this.opts.world, this.opts.dimension, entries.map((e) => ({ cx: e.cx, cz: e.cz })));
      let missing = 0;
      for (const payload of payloads) {
        seen.add(this.key(payload.cx, payload.cz));
        if (!payload.hash || payload.missing) missing++;
        this.handleFetchedHash(payload);
      }
      for (const e of entries) {
        if (!seen.has(this.key(e.cx, e.cz)) && e.state === 'checking') this.markUnavailable(e, 'absent', true);
      }
      debugLog('chunk-manager', 'hash-batch', { requested: entries.length, returned: payloads.length, missing });
    } catch (error) {
      debugLog('chunk-manager', 'hash-batch-error', { requested: entries.length, error: error instanceof Error ? error.message : String(error) });
      for (const e of entries) {
        if (e.state === 'checking') this.markUnavailable(e, 'error', false);
      }
      this.reportStats();
    } finally {
      this.finishActiveOperation(opId, performance.now() - started);
      this.checking--;
      this.flushHashQueue();
    }
  }

  private handleFetchedChunk(payload: ChunkPayload) {
    const key = this.key(payload.cx, payload.cz);
    const e = this.chunks.get(key);
    if (!e || e.state !== 'fetching') return;
    if (!payload.data || payload.missing) {
      this.markUnavailable(e, 'absent', true);
      return;
    }
    const sourceHash = payload.hash ?? payload.fileHash ?? null;
    const contentHash = this.payloadContentHash(payload);
    if (!contentHash) {
      this.markUnavailable(e, 'error', false, false);
      return;
    }
    const oldContentHash = this.contentHash(e);
    if (oldContentHash && oldContentHash !== contentHash) {
      this.resetAfterSourceChange(e);
    }
    e.sourceHash = sourceHash ?? contentHash;
    e.nbtHash = payload.nbtHash ?? null;
    e.source = payload.source ?? e.source;
    e.state = 'decoding';
    e.workerReadyMask = 0;
    this.chunkBytesFetched += payload.data.byteLength;
    const chunk = this.chunkBuffer(payload.data);
    this.sendChunkToWorkers({ type: 'chunk', key, cx: e.cx, cz: e.cz, dimension: this.opts.dimensionDef }, chunk);
  }

  private async fetchBatch(keys: string[]) {
    const entries = keys
      .map((key) => this.chunks.get(key))
      .filter((e): e is ChunkEntry => !!e && (e.state === 'hashed' || e.state === 'fetching'));
    if (!entries.length) return;
    for (const e of entries) e.state = 'fetching';
    this.fetching++;
    const started = performance.now();
    const opId = this.beginActiveOperation('chunkFetch', `${entries.length} chunks`, this.chunkFetchProfile);
    try {
      const seen = new Set<string>();
      const payloads = await fetchChunks(this.opts.world, this.opts.dimension, entries.map((e) => ({ cx: e.cx, cz: e.cz })));
      let missing = 0;
      let bytes = 0;
      for (const payload of payloads) {
        seen.add(this.key(payload.cx, payload.cz));
        if (!payload.data || payload.missing) missing++;
        else bytes += payload.data.byteLength;
        this.handleFetchedChunk(payload);
      }
      for (const e of entries) {
        if (!seen.has(this.key(e.cx, e.cz)) && e.state === 'fetching') this.markUnavailable(e, 'absent', true);
      }
      debugLog('chunk-manager', 'chunk-batch', { requested: entries.length, returned: payloads.length, missing, bytes });
    } catch (error) {
      debugLog('chunk-manager', 'chunk-batch-error', { requested: entries.length, error: error instanceof Error ? error.message : String(error) });
      for (const e of entries) {
        if (e.state === 'fetching') this.markUnavailable(e, 'error', false);
      }
      this.reportStats();
    } finally {
      this.finishActiveOperation(opId, performance.now() - started);
      this.fetching--;
      this.flushFetchQueue();
    }
  }

  // #endregion

  // #region Worker messages

  private handleMessage(msg: WorkerResponse, workerIndex: number) {
    switch (msg.type) {
      case 'chunkReady': {
        this.recordCompletedOperation('parse', this.parseProfile, msg.profile?.parseMs, msg.key);
        const e = this.chunks.get(msg.key);
        if (!e) { this.broadcast({ type: 'drop', key: msg.key }); return; }
        if (e.state !== 'decoding' && e.state !== 'stored') break;
        e.workerReadyMask |= 1 << workerIndex;
        e.biome = msg.biome;
        e.surfaceY = msg.surfaceY;
        if (e.workerReadyMask !== this.allWorkersMask()) break;
        e.state = 'stored';
        this.markNeighborsDirty(e);
        this.scheduler.scheduleStoredFromLastPriority(e, performance.now());
        this.flushMeshQueue();
        this.reportStats();
        break;
      }
      case 'chunkError': {
        const e = this.chunks.get(msg.key);
        if (e) this.markUnavailable(e, 'error');
        console.warn('chunk parse error', msg.key, msg.error);
        break;
      }
      case 'meshResult': {
        this.finishMeshDiagnostic(msg.version, msg.profile?.meshMs);
        this.finishActiveMesh(msg.version);
        const e = this.chunks.get(msg.key);
        const matched = e?.pendingFullVersion === msg.version;
        const cacheParts = matched ? e.pendingFullCacheParts : null;
        const dirtyToken = matched ? e.pendingFullDirtyToken : -1;
        if (!e || !matched) return;
        this.clearPendingMesh(e, 'full');
        if (msg.profile?.missingInput) {
          this.recoverMissingWorkerInput(e, 'full', 1);
          return;
        }
        if (e.state !== 'stored') {
          this.reportStats();
          return;
        }
        const shouldDisplay = this.shouldApplyMeshResult(e, 'full', 1, msg.version);
        if (cacheParts) void putCachedFull(cacheParts, msg.sections).catch(() => { });
        if (!shouldDisplay) {
          this.rescheduleStoredIfFresh(e);
          this.reportStats();
          return;
        }
        this.displayFull(e, msg.sections, msg.version);
        if (dirtyToken >= 0) this.clearDirtyIfUnchanged(e, dirtyToken);
        this.reportStats();
        break;
      }
      case 'lodResult': {
        this.finishMeshDiagnostic(msg.version, msg.profile?.meshMs);
        this.finishActiveMesh(msg.version);
        const e = this.chunks.get(msg.key);
        const step = (LOD_STEPS.includes(msg.step as LodStep) ? msg.step : 8) as LodStep;
        let cacheParts: MeshCacheBaseParts | null = null;
        let dirtyToken = -1;
        if (e && e.pendingLodStep === step && e.pendingLodVersion === msg.version) {
          cacheParts = e.pendingLodCacheParts;
          dirtyToken = e.pendingLodDirtyToken;
          this.clearPendingMesh(e, 'lod');
        }
        if (!e || dirtyToken < 0 || msg.version < e.displayedVersion) return;
        if (msg.profile?.missingInput) {
          this.recoverMissingWorkerInput(e, 'lod', step);
          return;
        }
        if (e.state !== 'stored') {
          this.reportStats();
          return;
        }
        const shouldDisplay = this.shouldApplyMeshResult(e, 'lod', step, msg.version);
        if (cacheParts) void putCachedLod({ ...cacheParts, step }, msg.mesh).catch(() => { });
        if (!shouldDisplay) {
          this.rescheduleStoredIfFresh(e);
          this.reportStats();
          return;
        }
        this.displayLod(e, msg.mesh, msg.version, step);
        if (dirtyToken >= 0) this.clearDirtyIfUnchanged(e, dirtyToken);
        this.maybeReleaseDisplayedLodData(e);
        this.reportStats();
        break;
      }
    }
  }

  // #endregion

  // #region Section visibility

  private visibilityAllows(mask: number, from: number, to: number): boolean {
    return Math.floor(mask / (2 ** (from * 6 + to))) % 2 >= 1;
  }

  private setAllFullSectionsVisible(visible: boolean) {
    for (const section of this.fullSectionIndex.values()) {
      for (const mesh of section.meshes) mesh.visible = visible;
    }
  }

  private fullSectionWithinTopClip(sy: number): boolean {
    if (!this.topDownView) return true;
    const sectionMinY = sy * 16;
    const sectionMaxY = sectionMinY + 16;
    return sectionMaxY > this.topClipRange.minY && sectionMinY < this.topClipRange.maxY;
  }

  private lodVisibleForTopClip(): boolean {
    return !this.topDownView || this.topClipRange.maxY >= CHUNK_WORLD_MAX_Y;
  }

  private applyFullSectionTopClip() {
    for (const section of this.fullSectionIndex.values()) {
      const visible = this.fullSectionWithinTopClip(section.sy);
      for (const mesh of section.meshes) mesh.visible = visible;
    }
  }

  private applyLodTopClip() {
    const visible = this.lodVisibleForTopClip();
    for (const e of this.chunks.values()) {
      if (e.displayed === 'lod' && e.group) e.group.visible = visible;
    }
  }

  private applyTopClipVisibility() {
    if (this.topDownView) this.applyFullSectionTopClip();
    else this.setAllFullSectionsVisible(true);
    this.applyLodTopClip();
  }

  private setMeshFrustumCulled(value: boolean) {
    for (const entry of this.chunks.values()) {
      entry.group?.traverse((child) => {
        if (child instanceof THREE.Mesh) child.frustumCulled = value;
      });
    }
  }

  private updateFullSectionVisibility(camera: ChunkSchedulerCamera) {
    if (!this.fullSectionIndex.size) return;
    if (this.topDownView) {
      this.applyFullSectionTopClip();
      return;
    }
    const startCx = Math.floor(camera.position.x / 16);
    const startSy = Math.floor(camera.position.y / 16);
    const startCz = Math.floor(camera.position.z / 16);
    const start = this.fullSectionIndex.get(this.sectionKey(startCx, startSy, startCz));
    if (!start || start.visibility <= 0) {
      this.setAllFullSectionsVisible(true);
      return;
    }
    const startEntry = this.chunks.get(this.key(startCx, startCz));
    if (startEntry && camera.position.y >= startEntry.surfaceY + 2) {
      this.setAllFullSectionsVisible(true);
      return;
    }
    if (start.visibility === SECTION_VISIBILITY_ALL) {
      this.setAllFullSectionsVisible(true);
      return;
    }

    const visible = new Set<string>();
    const queue: { section: FullSectionRender; entry: number }[] = [{ section: start, entry: -1 }];
    let head = 0;
    visible.add(start.key);

    while (head < queue.length) {
      const { section, entry } = queue[head++];
      const mask = section.visibility || SECTION_VISIBILITY_ALL;
      for (let dir = 0; dir < SECTION_VISIBILITY_DIRS.length; dir++) {
        if (entry >= 0 && !this.visibilityAllows(mask, entry, dir)) continue;
        const delta = SECTION_NEIGHBOR[dir];
        const next = this.fullSectionIndex.get(this.sectionKey(section.cx + delta[0], section.sy + delta[1], section.cz + delta[2]));
        if (!next) continue;
        if (visible.has(next.key)) continue;
        visible.add(next.key);
        queue.push({ section: next, entry: SECTION_OPPOSITE[dir] });
      }
    }

    for (const section of this.fullSectionIndex.values()) {
      const show = visible.has(section.key);
      for (const mesh of section.meshes) mesh.visible = show;
    }
  }

  // #endregion

  // #region Mesh display

  private displayFull(e: ChunkEntry, sections: SectionMeshMsg[], version: number) {
    this.removeMesh(e);
    const group = new THREE.Group();
    let meshBytes = 0;
    for (const s of sections) {
      const sectionMeshes: THREE.Mesh[] = [];
      const sectionVisible = this.fullSectionWithinTopClip(s.sy);
      for (const [layer, buffers] of Object.entries(s.layers) as [RenderLayer, MeshBuffers][]) {
        if (!this.hasRenderableGeometry(buffers)) continue;
        const built = this.buildGeometry(buffers, true);
        meshBytes += built.bytes;
        const mesh = new THREE.Mesh(built.geometry, this.materials[layer]);
        mesh.position.set(e.cx * 16, s.sy * 16, e.cz * 16);
        mesh.frustumCulled = !this.topDownView;
        mesh.visible = sectionVisible;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        group.add(mesh);
        sectionMeshes.push(mesh);
      }
      const section: FullSectionRender = {
        key: this.sectionKey(e.cx, s.sy, e.cz),
        cx: e.cx,
        sy: s.sy,
        cz: e.cz,
        visibility: s.visibility ?? SECTION_VISIBILITY_ALL,
        meshes: sectionMeshes,
      };
      e.fullSections.push(section);
      this.fullSectionIndex.set(section.key, section);
    }
    e.meshBytes = meshBytes;
    this.displayedMeshBytes += e.meshBytes;
    if (group.children.length > 0) {
      this.root.add(group);
      e.group = group;
    }
    e.displayed = 'full';
    e.displayedVersion = version;
    e.displayedLodStep = 0;
    e.fullReady = meshBytes > 0;
    debugLog('chunk-manager', 'display-full', {
      key: e.key,
      sections: e.fullSections.length,
      meshBytes: e.meshBytes,
      topDownView: this.topDownView,
      topClipRange: this.topClipRange,
    });
    this.reportStats();
  }

  private displayLod(e: ChunkEntry, meshBuffers: MeshBuffers | null, version: number, step: number) {
    this.removeMesh(e);
    if (meshBuffers && this.hasRenderableGeometry(meshBuffers)) {
      const built = this.buildGeometry(meshBuffers, false);
      e.meshBytes = built.bytes;
      this.displayedMeshBytes += e.meshBytes;
      const mesh = new THREE.Mesh(built.geometry, this.materials.lod);
      mesh.position.set(e.cx * 16, 0, e.cz * 16);
      mesh.frustumCulled = !this.topDownView;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      const group = new THREE.Group();
      group.add(mesh);
      group.visible = this.lodVisibleForTopClip();
      this.root.add(group);
      e.group = group;
    } else {
      e.meshBytes = 0;
    }
    e.displayed = 'lod';
    e.displayedVersion = version;
    e.displayedLodStep = step;
    e.lodReadyStep = e.meshBytes > 0 ? step : 0;
    if (e.lastTargetStep === 1) {
      this.scheduler.scheduleStoredFromLastPriority(e, performance.now());
      this.flushMeshQueue();
    }
    debugLog('chunk-manager', 'display-lod', { key: e.key, step, meshBytes: e.meshBytes, visible: e.group?.visible ?? false });
    this.reportStats();
  }

  private hasRenderableGeometry(b: MeshBuffers): boolean {
    return b.positions.length > 0 && b.indices.length > 0;
  }

  private buildGeometry(b: MeshBuffers, sectionBounds: boolean): { geometry: THREE.BufferGeometry; bytes: number } {
    const g = new THREE.BufferGeometry();
    const tiled = !!b.atlasRects;
    g.setAttribute('position', new THREE.BufferAttribute(b.positions, 3, true));
    if (b.uvs) g.setAttribute('uv', new THREE.BufferAttribute(b.uvs, 2, !tiled));
    if (b.atlasRects) g.setAttribute('atlasRect', new THREE.BufferAttribute(b.atlasRects, 4, true));
    g.setAttribute('tintColor', new THREE.BufferAttribute(b.colors, 3, true));
    g.setAttribute('lightData', new THREE.BufferAttribute(b.lights, 2, true));
    g.setIndex(new THREE.BufferAttribute(b.indices, 1));
    if (sectionBounds) {
      g.boundingBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(16, 16, 16));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(8, 8, 8), 16);
    } else if (b.bounds) {
      g.boundingBox = new THREE.Box3(
        new THREE.Vector3(b.bounds.min[0], b.bounds.min[1], b.bounds.min[2]),
        new THREE.Vector3(b.bounds.max[0], b.bounds.max[1], b.bounds.max[2]),
      );
      const center = new THREE.Vector3();
      g.boundingBox.getCenter(center);
      const radius = center.distanceTo(new THREE.Vector3(b.bounds.max[0], b.bounds.max[1], b.bounds.max[2]));
      g.boundingSphere = new THREE.Sphere(center, radius);
    } else {
      g.computeBoundingBox();
      g.computeBoundingSphere();
    }
    return {
      geometry: g,
      bytes: b.positions.byteLength + (b.uvs?.byteLength ?? 0) + (b.atlasRects?.byteLength ?? 0)
        + b.colors.byteLength + b.lights.byteLength + b.indices.byteLength,
    };
  }

  private removeMesh(e: ChunkEntry) {
    for (const section of e.fullSections) this.fullSectionIndex.delete(section.key);
    e.fullSections = [];
    if (e.group) {
      this.root.remove(e.group);
      e.group.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    }
    this.displayedMeshBytes = Math.max(0, this.displayedMeshBytes - e.meshBytes);
    e.meshBytes = 0;
    e.group = null;
    e.displayed = 'none';
    e.displayedLodStep = 0;
    e.lodReadyStep = 0;
    e.fullReady = false;
  }

  // #endregion

  // #region Stats

  private entryHasVisibleMesh(e: ChunkEntry): boolean {
    if (!e.group || !e.group.visible) return false;
    let visible = false;
    e.group.traverse((child) => {
      if (visible) return;
      if (child instanceof THREE.Mesh && child.visible) visible = true;
    });
    return visible;
  }

  private entryHasDisplayedMesh(e: ChunkEntry): boolean {
    if (!e.group || !e.group.visible) return false;
    if (e.displayed === 'lod') return e.group.children.some((child) => child instanceof THREE.Mesh && child.visible);
    if (e.displayed !== 'full') return false;
    return e.fullSections.some((section) => section.meshes.some((mesh) => mesh.visible));
  }

  private collectRenderStats(): ChunkRenderStats {
    let nbt = 0, lodReady = 0, lodRendered = 0, fullReady = 0, fullRendered = 0;
    for (const e of this.chunks.values()) {
      if (e.state === 'decoding' || e.state === 'stored') nbt++;
      if (e.lodReadyStep > 0) lodReady++;
      if (e.displayed === 'lod' && this.entryHasVisibleMesh(e)) lodRendered++;
      if (e.fullReady) fullReady++;
      if (e.displayed === 'full' && this.entryHasVisibleMesh(e)) fullRendered++;
    }
    return { nbt, lodReady, lodRendered, fullReady, fullRendered };
  }

  private collectProfileStats(renderStats: ChunkRenderStats): ChunkProfileStats {
    return {
      workerCount: this.workers.length,
      activeMeshTasks: this.activeMeshTasks,
      workerChunkCopies: renderStats.nbt * this.workers.length,
      displayedMeshBytes: this.displayedMeshBytes,
      chunkBytesFetched: this.chunkBytesFetched,
      diagnostics: [...this.diagnostics],
      hashFetchMsAvg: this.average(this.hashFetchProfile),
      chunkFetchMsAvg: this.average(this.chunkFetchProfile),
      parseMsAvg: this.average(this.parseProfile),
      fullMeshMsAvg: this.average(this.fullMeshProfile),
      lodMeshMsAvg: this.average(this.lodMeshProfile),
      fullCacheHits: this.fullCacheHits,
      fullCacheMisses: this.fullCacheMisses,
      lodCacheHits: this.lodCacheHits,
      lodCacheMisses: this.lodCacheMisses,
    };
  }

  private syncSchedulerStats(): ChunkSchedulerStats {
    const renderStats = this.collectRenderStats();
    this.schedulerStats = this.scheduler.syncStats(renderStats, this.collectProfileStats(renderStats));
    return this.schedulerStats;
  }

  private reportStats() {
    this.onStats?.(this.syncSchedulerStats());
  }

  // #endregion

  // #region Cleanup

  dispose() {
    this.disposed = true;
    for (const e of this.chunks.values()) this.removeMesh(e);
    this.chunks.clear();
    this.scheduler.clear();
    if (this.hashTimer) {
      clearTimeout(this.hashTimer);
      this.hashTimer = null;
    }
    if (this.fetchTimer) {
      clearTimeout(this.fetchTimer);
      this.fetchTimer = null;
    }
    for (const timer of this.deferredMeshTimers.values()) clearTimeout(timer);
    this.deferredMeshTimers.clear();
    this.scene.remove(this.root);
    this.inFlightMeshVersions.clear();
    this.versionWorker.clear();
    this.meshDiagnosticByVersion.clear();
    this.activeDiagnostics.clear();
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.workerLoads = [];
  }

  // #endregion
}
