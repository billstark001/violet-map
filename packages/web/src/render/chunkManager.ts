import type { RenderLayer } from '@violet-map/core/assets';
import { type ChunkCoverage, type ChunkPayload } from '@violet-map/core/contracts';
import type { DimensionDef } from '@violet-map/core/domain';
import { ResourceError } from '@violet-map/core/resources';
import type { MeshBuffers } from '@violet-map/render';
import { meshByteLength, SECTION_VISIBILITY_ALL } from '@violet-map/render';
import * as THREE from 'three';
import { resolveChunks, readChunks, fetchChunkSourceCoverage, type ResolvedChunk } from '../api';
import { debugLog, isDebugLoggingEnabled } from '../logger';
import { getCachedMesh, putCachedMesh, type MeshCacheKeyParts } from '../meshCache';
import {
  chunkKey,
  type SectionMeshMsg,
  type WorkerInit,
  type WorkerRequest,
  type WorkerResponse,
} from '../worker/protocol';
import {
  ChunkScheduler,
  EMPTY_CHUNK_SCHEDULER_STATS,
  LOD_STEPS,
  type ChunkDiagnosticEvent,
  type ChunkDiagnosticOp,
  type ChunkPriority,
  type ChunkProfileStats,
  type ChunkRenderStats,
  type ChunkSchedulerCamera,
  type ChunkSchedulerDiagnosticSnapshot,
  type ChunkSchedulerEntry,
  type ChunkSchedulerStats,
  type ChunkSchedulingTuning,
  type ChunkState,
  type LodStep,
  type MeshTaskKind,
  type SchedulerAction,
} from './chunkScheduler';
import type { TerrainMaterials } from './materials';

const UPDATE_INTERVAL_MS = 80;
const STATS_REPORT_INTERVAL_MS = 100;
const MAX_ACTIVE_MESH_TASKS = 4;
const DEFAULT_MAX_MESH_WORKERS = 2;
const ABSOLUTE_MAX_MESH_WORKERS = 4;
const WORKER_LIMIT_STORAGE_KEY = 'violet-map:maxMeshWorkers';
const STALE_WORKER_RELEASE_MS = 4000;
const STALE_MESH_RELEASE_MS = 8000;
const WORKER_NEIGHBOR_HOLD_MS = 3500;
const DEFERRED_MESH_RETRY_MS = 140;
const MIN_WORKER_RESIDENT_COLUMNS = 192;
const MAX_WORKER_RESIDENT_COLUMNS = 1400;
// Every resident column is cloned into every meshing worker. Budget the total
// number of copies, rather than letting worker count multiply memory usage.
const TARGET_WORKER_RESIDENT_COPIES = 768;
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

interface ChunkSourceCoverage {
  regions: Set<string>;
  regionMasks: Map<string, Uint8Array>;
  chunks: Set<string>;
  hasRegionMasks: boolean;
}

export interface TopClipRange {
  minY: number;
  maxY: number;
}

export interface ChunkEntryDiagnosticSnapshot {
  key: string;
  cx: number;
  cz: number;
  state: ChunkState;
  contentDigest: string | null;
  biome: string;
  surfaceY: number;
  displayed: ChunkEntry['displayed'];
  displayedLodStep: number;
  fullReady: boolean;
  lodReadyStep: number;
  dirty: boolean;
  dirtyToken: number;
  pendingFull: boolean;
  pendingLod: boolean;
  pendingLodStep: number;
  workerReadyCount: number;
  meshBytes: number;
  targetStep: LodStep;
  lastWantedAt: number;
  lastTier: number;
  lastScore: number;
  importance: number;
  satisfaction: number;
  gap: number;
  precision: number | null;
  height: number | null;
  bump: number | null;
  retryAt: number;
  lastError?: string;
}

export interface ChunkManagerDiagnosticSnapshot {
  schema: 1;
  capturedAt: string;
  world: string;
  dimension: string;
  renderKey: string;
  topDownView: boolean;
  topClipRange: TopClipRange;
  scheduling: ChunkSchedulerDiagnosticSnapshot;
  stats: ChunkSchedulerStats;
  workers: {
    count: number;
    loads: number[];
    activeMeshTasks: number;
    checking: number;
    fetching: number;
    cacheLookups: number;
    waitingMeshes: number;
    oldestTaskMs: number;
    restarts: number;
  };
  activity: {
    chunkDispatches: number;
    meshRequests: number;
    meshApplications: number;
    retries: number;
    lastProgressAt: number;
  };
  coverage: {
    loaded: boolean;
    regionCount: number;
    regionMaskCount: number;
    directChunkCount: number;
  };
  chunks: ChunkEntryDiagnosticSnapshot[];
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

function normalizeChunkSourceCoverage(payload: ChunkCoverage): ChunkSourceCoverage {
  const regions = new Set<string>();
  const regionMasks = new Map<string, Uint8Array>();
  const chunks = new Set<string>();
  let hasRegionMasks = false;

  for (const region of payload.regions ?? []) {
    if (!Number.isInteger(region.x) || !Number.isInteger(region.z)) continue;
    const key = `${region.x},${region.z}`;
    regions.add(key);
    if (typeof region.mask === 'string') {
      const mask = decodeCoverageMask(region.mask);
      if (mask.byteLength >= 128) {
        regionMasks.set(key, mask);
        hasRegionMasks = true;
      }
    }
  }

  for (const chunk of payload.chunks ?? []) {
    if (!Number.isInteger(chunk.cx) || !Number.isInteger(chunk.cz)) continue;
    chunks.add(`${chunk.cx},${chunk.cz}`);
  }

  return { regions, regionMasks, chunks, hasRegionMasks };
}

function decodeCoverageMask(value: string): Uint8Array {
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array(0);
  }
}

interface FullSectionRender {
  key: string;
  cx: number;
  sy: number;
  cz: number;
  visibility: number;
  meshes: THREE.Mesh[];
  specialMeshes: THREE.Mesh[];
  visible: boolean;
}

interface ChunkEntry extends ChunkSchedulerEntry {
  retryAttempts: number;
  lastError?: string;
  readyContentDigest?: string;
  workerPins: number;
  decodingStartedAt?: number;
  estimatedColumnBytes: number;
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
  group: THREE.Object3D | null;
  fullSections: FullSectionRender[];
  meshBytes: number;
  biome: string;
  surfaceY: number;
  contentDigest: string | null;
  resolution?: ResolvedChunk;
}

interface MeshJob {
  entry: ChunkEntry;
  kind: MeshTaskKind;
  step: LodStep;
  phase: 'cache' | 'queued' | 'worker';
  startedAt: number;
  dependencies: ChunkEntry[];
}

export interface ChunkManagerOptions {
  renderRoot: string;
  sourceScope: string;
  world: string;
  dimension: string;
  renderKey: string;
  dimensionDef: DimensionDef;
  /** When true, chunk scheduling never requests LOD meshes; only full meshes are generated/displayed. */
  disableLod?: boolean;
  topMapSurfaceYAt?: (cx: number, cz: number) => number | null;
  /** Optional camera-grid tracker tuning. */
  scheduling?: ChunkSchedulingTuning;
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
  private meshJobs = new Map<number, MeshJob>();
  private meshFlushScheduled = false;
  private healthTimer?: ReturnType<typeof setInterval>;
  private workerRestartTimer?: ReturnType<typeof setTimeout>;
  private workerRestarts = 0;
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
  private lastStatsReport = -Infinity;
  private chunkBytesDecoded = 0;
  private activity = { chunkDispatches: 0, meshRequests: 0, meshApplications: 0, retries: 0, lastProgressAt: 0 };
  private displayedMeshBytes = 0;
  private fullCacheHits = 0;
  private fullCacheMisses = 0;
  private lodCacheHits = 0;
  private lodCacheMisses = 0;
  private schedulerStats: ChunkSchedulerStats = { ...EMPTY_CHUNK_SCHEDULER_STATS };
  private lastUpdate = 0;
  private disposed = false;
  private readonly requests = new AbortController();
  private coverageSeq = 0;
  private chunkCoverage: ChunkSourceCoverage | null = null;
  private topDownView = false;
  private topClipRange: TopClipRange = { minY: CHUNK_WORLD_MIN_Y, maxY: CHUNK_WORLD_MAX_Y };
  private latestCamera: ChunkSchedulerCamera | null = null;
  private displayedChunkKeyCache: ReadonlySet<string> = new Set();
  private displayedChunkKeyCacheDirty = true;
  private visibilityRevision = 0;
  private lastVisibilityRevision = -1;
  private lastVisibilityStartKey = '';
  private lastVisibilityAboveSurface = false;
  private visibleSectionKeys = new Set<string>();
  private visibilityEntryMasks = new Map<string, number>();
  private visibilityQueueSections: FullSectionRender[] = [];
  private visibilityQueueEntries: number[] = [];
  private sectionVisibilityRevision = 0;
  private lastSpecialVisibilityRevision = -1;
  private lastSpecialCenterCx = Number.NaN;
  private lastSpecialCenterCz = Number.NaN;
  private lastSpecialRadius = Number.NaN;
  readonly root = new THREE.Group();
  onStats?: (s: ChunkSchedulerStats) => void;

  // #region Lifecycle

  constructor(
    private scene: THREE.Scene,
    private materials: TerrainMaterials,
    private initPayload: Omit<WorkerInit, 'type'>,
    public opts: ChunkManagerOptions,
  ) {
    this.scheduler = new ChunkScheduler(this.schedulerOptions());
    this.root.matrixAutoUpdate = false;
    this.root.updateMatrix();
    scene.add(this.root);
    void this.loadChunkSourceCoverage();
    const workerCount = this.resolveWorkerCount();
    for (let i = 0; i < workerCount; i++) {
      this.createWorker(i);
    }
    this.healthTimer = setInterval(() => this.checkWorkerHealth(), 1000);
  }

  // #endregion

  // #region Keys and workers

  private resolveWorkerCount(): number {
    const hardware = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
    const hardwareLimit = hardware > 2 ? hardware - 1 : 1;
    const memory =
      typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined;
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

  private createWorker(index: number) {
    const worker = new Worker(new URL('../worker/meshWorker.ts', import.meta.url), { type: 'module' });
    this.workers[index] = worker;
    this.workerLoads[index] = 0;
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      if (this.workers[index] === worker) this.handleMessage(ev.data, index);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.recoverWorkers(event.message || 'mesh worker failed');
    };
    worker.onmessageerror = () => this.recoverWorkers('mesh worker message could not be decoded');
    worker.postMessage({ type: 'init', ...this.initPayload } satisfies WorkerInit);
  }

  private checkWorkerHealth() {
    if (this.disposed) return;
    const now = performance.now();
    if (
      [...this.meshJobs.values()].some((job) => job.phase === 'worker' && now - job.startedAt > 30000) ||
      [...this.chunks.values()].some((e) => e.state === 'decoding' && now - (e.decodingStartedAt ?? now) > 30000)
    )
      this.recoverWorkers('mesh worker exceeded its progress deadline');
  }

  private recoverWorkers(reason: string) {
    if (this.disposed || this.workerRestartTimer) return;
    const count = this.resolveWorkerCount();
    const affected = new Set([...this.meshJobs.values()].map((job) => job.entry));
    for (const [version, job] of this.meshJobs) {
      this.clearPendingMesh(job.entry, job.kind);
      this.finishMeshDiagnostic(version, undefined);
      this.finishActiveMesh(version);
    }
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.workerLoads = [];
    this.workerRestarts++;
    for (const e of this.chunks.values()) {
      if (e.state === 'stored' || e.state === 'decoding') e.state = 'hashed';
      e.workerReadyMask = 0;
      e.decodingStartedAt = undefined;
      if (affected.has(e)) {
        e.dirty = true;
        e.dirtyToken++;
        this.queueFetch(e.key);
      }
    }
    debugLog('chunk-manager', 'worker-restart', { reason, count: this.workerRestarts });
    this.workerRestartTimer = setTimeout(
      () => {
        this.workerRestartTimer = undefined;
        if (this.disposed) return;
        try {
          for (let i = 0; i < count; i++) this.createWorker(i);
        } catch (error) {
          this.recoverWorkers(error instanceof Error ? error.message : String(error));
          return;
        }
        this.flushHashQueue();
        this.flushFetchQueue();
        this.flushMeshQueue();
      },
      Math.min(5000, 250 * this.workerRestarts),
    );
  }

  private key(cx: number, cz: number) {
    return chunkKey(this.opts.world, this.opts.dimension, cx, cz);
  }
  private sectionKey(cx: number, sy: number, cz: number) {
    return `${cx},${sy},${cz}`;
  }
  private allWorkersMask(): number {
    return (1 << Math.max(1, this.workers.length)) - 1;
  }
  private sendToWorker(workerIndex: number, msg: WorkerRequest, transfer: Transferable[] = []) {
    this.workers[workerIndex]?.postMessage(msg, transfer);
  }
  private broadcast(msg: WorkerRequest) {
    for (const worker of this.workers) worker.postMessage(msg);
  }
  private sendChunkToWorkers(
    msg: Omit<Extract<WorkerRequest, { type: 'chunk' }>, 'chunk' | 'entities'>,
    chunk: ArrayBuffer,
    entities?: ArrayBuffer,
  ) {
    const last = this.workers.length - 1;
    for (let i = 0; i < this.workers.length; i++) {
      const copy = i === last ? chunk : chunk.slice(0);
      const entityCopy = entities ? (i === last ? entities : entities.slice(0)) : undefined;
      this.workers[i].postMessage(
        { ...msg, chunk: copy, ...(entityCopy ? { entities: entityCopy } : {}) } satisfies WorkerRequest,
        entityCopy ? [copy, entityCopy] : [copy],
      );
    }
  }

  // #endregion

  // #region Source coverage

  private async loadChunkSourceCoverage() {
    const seq = ++this.coverageSeq;
    this.chunkCoverage = null;
    try {
      const payload = await fetchChunkSourceCoverage(this.opts.world, this.opts.dimension, this.requests.signal);
      if (this.disposed || seq !== this.coverageSeq) return;
      this.chunkCoverage = normalizeChunkSourceCoverage(payload);
      let markedAbsent = 0;
      for (const e of this.chunks.values()) {
        if (this.hasChunkSourceAt(e.cx, e.cz) !== false) continue;
        if (e.state !== 'absent') markedAbsent++;
        this.markUnavailable(e, 'absent', true);
      }
      if (markedAbsent > 0) this.scheduler.clear();
      debugLog('chunk-manager', 'coverage-loaded', {
        world: this.opts.world,
        dimension: this.opts.dimension,
        regions: this.chunkCoverage.regions.size,
        regionMasks: this.chunkCoverage.regionMasks.size,
        chunks: this.chunkCoverage.chunks.size,
        markedAbsent,
      });
      this.reportStats();
    } catch (error) {
      if (this.disposed || seq !== this.coverageSeq) return;
      this.chunkCoverage = null;
      debugLog('chunk-manager', 'coverage-error', {
        world: this.opts.world,
        dimension: this.opts.dimension,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private hasChunkSourceAt(cx: number, cz: number): boolean | null {
    const coverage = this.chunkCoverage;
    if (!coverage) return null;
    if (coverage.chunks.has(`${cx},${cz}`)) return true;
    const regionKey = `${Math.floor(cx / 32)},${Math.floor(cz / 32)}`;
    if (!coverage.regions.has(regionKey)) return false;
    if (!coverage.hasRegionMasks) return true;

    const mask = coverage.regionMasks.get(regionKey);
    if (!mask) return false;
    const index = (cx & 31) + ((cz & 31) << 5);
    return (mask[index >> 3] & (1 << (index & 7))) !== 0;
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

  displayedChunkKeys(): ReadonlySet<string> {
    if (!this.displayedChunkKeyCacheDirty) return this.displayedChunkKeyCache;
    const out = new Set<string>();
    for (const e of this.chunks.values()) {
      if (e.displayed === 'none' || !this.entryHasDisplayedMesh(e)) continue;
      out.add(`${e.cx},${e.cz}`);
    }
    this.displayedChunkKeyCache = out;
    this.displayedChunkKeyCacheDirty = false;
    return out;
  }

  setScheduling(scheduling: ChunkSchedulingTuning | undefined) {
    this.opts = { ...this.opts, scheduling };
  }

  /** A JSON-safe, point-in-time view used by the settings diagnosis export. */
  diagnosticSnapshot(): ChunkManagerDiagnosticSnapshot {
    const now = performance.now();
    const stats = this.syncSchedulerStats();
    const coverage = this.chunkCoverage;
    const chunks = [...this.chunks.values()]
      .sort((a, b) => a.cz - b.cz || a.cx - b.cx)
      .map((entry): ChunkEntryDiagnosticSnapshot => {
        const tracker = this.scheduler.diagnosticCell(entry.cx, entry.cz);
        return {
          key: entry.key,
          cx: entry.cx,
          cz: entry.cz,
          state: entry.state,
          contentDigest: entry.contentDigest,
          biome: entry.biome,
          surfaceY: entry.surfaceY,
          displayed: entry.displayed,
          displayedLodStep: entry.displayedLodStep,
          fullReady: entry.fullReady,
          lodReadyStep: entry.lodReadyStep,
          dirty: entry.dirty,
          dirtyToken: entry.dirtyToken,
          pendingFull: entry.pendingFull,
          pendingLod: entry.pendingLod,
          pendingLodStep: entry.pendingLodStep,
          workerReadyCount: this.workerReadyCount(entry),
          meshBytes: entry.meshBytes,
          targetStep: entry.lastTargetStep,
          lastWantedAt: entry.lastWantedAt,
          lastTier: entry.lastTier,
          lastScore: entry.lastScore,
          importance: tracker?.importance ?? entry.lastImportance,
          satisfaction: tracker?.satisfaction ?? entry.lastSatisfaction,
          gap: tracker?.gap ?? entry.lastGap,
          precision: tracker?.precision ?? null,
          height: tracker?.height ?? null,
          bump: tracker?.bump ?? null,
          retryAt: entry.retryAt ?? 0,
          lastError: entry.lastError,
        };
      });

    return {
      schema: 1,
      capturedAt: new Date().toISOString(),
      world: `${this.opts.sourceScope}:${this.opts.world}`,
      dimension: this.opts.dimension,
      renderKey: this.opts.renderKey,
      topDownView: this.topDownView,
      topClipRange: { ...this.topClipRange },
      scheduling: this.scheduler.diagnosticSnapshot(now),
      stats: { ...stats, diagnostics: [...stats.diagnostics] },
      workers: {
        count: this.workers.length,
        loads: [...this.workerLoads],
        activeMeshTasks: this.activeMeshTasks,
        checking: this.checking,
        fetching: this.fetching,
        cacheLookups: [...this.meshJobs.values()].filter((job) => job.phase === 'cache').length,
        waitingMeshes: [...this.meshJobs.values()].filter((job) => job.phase === 'queued').length,
        oldestTaskMs: Math.max(0, ...[...this.meshJobs.values()].map((job) => now - job.startedAt)),
        restarts: this.workerRestarts,
      },
      activity: { ...this.activity },
      coverage: {
        loaded: coverage !== null,
        regionCount: coverage?.regions.size ?? 0,
        regionMaskCount: coverage?.regionMasks.size ?? 0,
        directChunkCount: coverage?.chunks.size ?? 0,
      },
      chunks,
    };
  }

  // #endregion

  // #region Scheduler bridge

  private schedulerEntryForKey(key: string): ChunkSchedulerEntry | null {
    return this.chunks.get(key) ?? null;
  }

  private schedulerEntries(): Iterable<ChunkSchedulerEntry> {
    // Map#values returns a single-use iterator. The scheduler intentionally
    // walks entries several times per frame (ranking, queue selection and
    // eviction), so expose a re-iterable view instead. Returning the iterator
    // here caused the full->LOD scan to consume it before eviction, allowing
    // tracked chunks to grow far beyond the resident limit.
    const chunks = this.chunks;
    return {
      [Symbol.iterator](): Iterator<ChunkSchedulerEntry> {
        return chunks.values();
      },
    };
  }

  private schedulerOptions() {
    return {
      disableLod: this.opts.disableLod === true,
      scheduling: this.opts.scheduling,
    };
  }

  private applySchedulerAction(action: SchedulerAction, now: number) {
    switch (action.type) {
      case 'wantChunk':
        this.ensureEntry(action.cx, action.cz, now);
        return;
      case 'removeMesh': {
        const e = this.chunks.get(action.key);
        if (e) this.removeMesh(e);
        return;
      }
      case 'dropChunk': {
        const e = this.chunks.get(action.key);
        if (e) this.dropEntry(action.key, e);
        return;
      }
    }
  }

  /** 每帧调用（内部节流）。 */
  update(camera: ChunkSchedulerCamera, now: number, force = false, topDownView = false, topClipRange?: TopClipRange) {
    this.latestCamera = camera;
    const nextTopClipRange = normalizeTopClipRange(topClipRange);
    const clipChanged =
      nextTopClipRange.minY !== this.topClipRange.minY || nextTopClipRange.maxY !== this.topClipRange.maxY;
    const viewChanged = this.topDownView !== topDownView;
    if (viewChanged || clipChanged) {
      this.topDownView = topDownView;
      this.topClipRange = nextTopClipRange;
      this.applyTopClipVisibility();
      if (viewChanged) this.lastVisibilityRevision = -1;
    }
    if (!force && now - this.lastUpdate < UPDATE_INTERVAL_MS) return;
    this.lastUpdate = now;

    const entriesBefore = this.chunks.size;
    const frame = this.scheduler.tick({
      camera,
      now,
      force,
      topDownView,
      options: this.schedulerOptions(),
      keyFor: (cx, cz) => this.key(cx, cz),
      entryFor: (key) => this.schedulerEntryForKey(key),
      cellInfoFor: (cx, cz) => ({
        topMapSurfaceY: this.opts.topMapSurfaceYAt?.(cx, cz) ?? null,
        hasChunkSource: this.hasChunkSourceAt(cx, cz),
      }),
      entries: this.schedulerEntries(),
    });

    for (const update of frame.entryUpdates) {
      const e = this.ensureEntry(update.cx, update.cz, now);
      e.lastWantedAt = update.lastWantedAt;
      e.lastTier = update.lastTier;
      e.lastScore = update.lastScore;
      e.lastTargetStep = update.lastTargetStep;
      e.lastForcedFull = update.lastForcedFull;
      e.lastImportance = update.lastImportance;
      e.lastSatisfaction = update.lastSatisfaction;
      e.lastGap = update.lastGap;
    }

    for (const action of frame.actions) this.applySchedulerAction(action, now);
    this.releaseStaleEntries(frame.keepKeys, now);
    this.releaseWorkerDataOverBudget();
    this.checkDelayedOperations(now);
    this.flushMeshQueue();
    this.flushHashQueue();
    this.flushFetchQueue();
    this.flushMeshQueue();
    this.updateFullSectionVisibility(camera);
    this.updateSpecialRenderVisibility(camera);
    if (isDebugLoggingEnabled()) {
      this.syncSchedulerStats();
      debugLog('chunk-manager', 'update', {
        world: this.opts.world,
        dimension: this.opts.dimension,
        topDownView,
        topClipRange: this.topClipRange,
        candidates: frame.candidateCount,
        keepKeys: frame.keepKeys.size,
        entriesBefore,
        entriesAfter: this.chunks.size,
        evicted: frame.evictedCount,
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
      cx,
      cz,
      state: 'checking',
      retryAt: 0,
      retryAttempts: 0,
      workerPins: 0,
      estimatedColumnBytes: 0,
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
      contentDigest: null,
      lastWantedAt: now,
      lastTier: 6,
      lastScore: Infinity,
      lastTargetStep: 8,
      lastForcedFull: false,
      lastImportance: 0,
      lastSatisfaction: 0,
      lastGap: 0,
    };
    this.chunks.set(key, e);
    return e;
  }

  private rescheduleStoredIfFresh(e: ChunkEntry) {
    const now = performance.now();
    this.scheduler.notify({ type: 'chunkStored', entry: e, now });
    this.flushMeshQueue();
  }

  // #endregion

  // #region Mesh task lifecycle

  private flushMeshQueue() {
    if (this.disposed || !this.workers.length) return;
    for (const [version, job] of this.meshJobs) {
      if (this.activeMeshTasks >= this.maxActiveMeshTasks()) break;
      if (job.phase === 'queued') this.startWorkerMeshing(job.entry, job.kind, job.step, version);
    }
    while (this.meshJobs.size < this.maxActiveMeshTasks() * 2) {
      const work = this.scheduler.nextWork({
        now: performance.now(),
        activeHashBatches: this.checking,
        activeFetchBatches: this.fetching,
        activeMeshTasks: this.meshJobs.size,
        maxMeshTasks: this.maxActiveMeshTasks() * 2,
        entries: this.schedulerEntries(),
        entryFor: (key) => this.schedulerEntryForKey(key),
        includeHash: false,
        includeFetch: false,
        includeMesh: true,
      });
      if (!work.meshTasks.length) return;
      let startedAny = false;
      for (const task of work.meshTasks) {
        const e = this.chunks.get(task.key);
        if (!e || e.pendingFull || e.pendingLod) continue;
        startedAny = this.requestMesh(e, task.kind, task.step) || startedAny;
      }
      if (!startedAny) return;
    }
  }

  private maxActiveMeshTasks(): number {
    return Math.max(1, Math.min(MAX_ACTIVE_MESH_TASKS, this.workers.length || 1));
  }

  private finishActiveMesh(version: number) {
    const job = this.meshJobs.get(version);
    if (!job) return;
    this.meshJobs.delete(version);
    for (const dependency of job.dependencies) dependency.workerPins--;
    if (this.inFlightMeshVersions.delete(version)) {
      const workerIndex = this.versionWorker.get(version);
      if (workerIndex !== undefined) {
        this.workerLoads[workerIndex] = Math.max(0, (this.workerLoads[workerIndex] ?? 0) - 1);
        this.versionWorker.delete(version);
      }
      this.activeMeshTasks = Math.max(0, this.activeMeshTasks - 1);
    }
    // A result must update pending/displayed state before another task can
    // observe it. In particular cache hits must not synchronously re-enter.
    if (!this.meshFlushScheduled) {
      this.meshFlushScheduled = true;
      queueMicrotask(() => {
        this.meshFlushScheduled = false;
        if (!this.disposed) this.flushMeshQueue();
      });
    }
  }

  private markWorkerMesh(version: number): number {
    this.activity.meshRequests++;
    this.activeMeshTasks++;
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
    this.scheduler.notify({ type: 'meshDeferred', key: e.key, kind, step, fallbackTier, now: performance.now() });
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
    }, DEFERRED_MESH_RETRY_MS);
    this.deferredMeshTimers.set(timerKey, timer);
  }

  private beginPendingMesh(e: ChunkEntry, kind: MeshTaskKind, step: LodStep, cache: CachePartsResult): number {
    const version = ++this.versionCounter;
    this.meshJobs.set(version, {
      entry: e,
      kind,
      step,
      phase: 'cache',
      startedAt: performance.now(),
      dependencies: [],
    });
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
    const priority = this.meshNeighborPriority(e, e, performance.now());
    if (e.state === 'stored') {
      e.workerReadyMask = 0;
      e.state = 'hashed';
    }
    if (e.state === 'checking') this.queueHash(e.key, priority);
    else if (e.state === 'hashed') this.queueFetch(e.key, priority);
    else if (e.state === 'fetching') this.flushFetchQueue();
    this.deferMesh(e, kind, step, kind === 'full' ? 3 : 4);
    this.reportStats();
  }

  private shouldApplyMeshResult(e: ChunkEntry, kind: MeshTaskKind, step: LodStep, version: number): boolean {
    return this.scheduler.shouldAcceptMeshResult({ entry: e, kind, step, version, now: performance.now() });
  }

  private startWorkerMeshing(e: ChunkEntry, kind: MeshTaskKind, step: LodStep, version: number) {
    const job = this.meshJobs.get(version);
    if (!job) return;
    if (!this.shouldApplyMeshResult(e, kind, step, version)) {
      this.clearPendingMesh(e, kind);
      this.finishActiveMesh(version);
      return;
    }
    if (!this.ensureNeighborhoodWorkerData(e, performance.now())) {
      this.clearPendingMesh(e, kind);
      this.finishActiveMesh(version);
      this.deferMesh(e, kind, step, kind === 'full' ? 3 : 4);
      this.flushHashQueue();
      this.flushFetchQueue();
      return;
    }
    if (this.activeMeshTasks >= this.maxActiveMeshTasks()) {
      job.phase = 'queued';
      return;
    }
    const cache = this.neighborhoodCacheParts(e);
    if (kind === 'full') {
      e.pendingFullCacheParts = cache?.stable ? cache.parts : null;
      e.pendingFullDirtyToken = e.dirtyToken;
    } else {
      e.pendingLodCacheParts = cache?.stable ? cache.parts : null;
      e.pendingLodDirtyToken = e.dirtyToken;
    }
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const n = this.chunks.get(this.key(e.cx + dx, e.cz + dz));
        if (n?.state === 'stored') {
          n.workerPins++;
          job.dependencies.push(n);
        }
      }
    job.phase = 'worker';
    job.startedAt = performance.now();
    const workerIndex = this.markWorkerMesh(version);
    const op = kind === 'full' ? 'fullMesh' : 'lodMesh';
    const profile = kind === 'full' ? this.fullMeshProfile : this.lodMeshProfile;
    const detail = kind === 'full' ? e.key : `${e.key} LOD ${step}`;
    this.meshDiagnosticByVersion.set(version, this.beginActiveOperation(op, detail, profile));
    try {
      if (kind === 'full') this.sendToWorker(workerIndex, { type: 'mesh', key: e.key, version });
      else this.sendToWorker(workerIndex, { type: 'lod', key: e.key, step, version });
    } catch (error) {
      this.recoverWorkers(error instanceof Error ? error.message : String(error));
    }
  }

  // #endregion

  // #region Chunk state and cache keys

  private dropEntry(key: string, e: ChunkEntry) {
    if (e.workerPins > 0 || e.pendingFull || e.pendingLod) return;
    this.removeMesh(e);
    if (e.state === 'stored' || e.state === 'decoding') this.broadcast({ type: 'drop', key });
    this.chunks.delete(key);
    this.scheduler.notify({ type: 'chunkDropped', key });
  }

  private cacheParts(e: ChunkEntry): MeshCacheBaseParts {
    const contentHash = e.contentDigest;
    if (!contentHash) throw new Error(`missing content hash for mesh cache key: ${e.key}`);
    return {
      world: `${this.opts.sourceScope}:${this.opts.world}`,
      dimension: this.opts.dimension,
      renderKey: this.opts.renderKey,
      cx: e.cx,
      cz: e.cz,
      contentKey: contentHash,
    };
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
    const now = performance.now();
    e.dirty = true;
    e.dirtyToken++;
    e.lastWantedAt = now;
    e.lastTier = Math.min(e.lastTier, 0);
    e.lastScore = Math.min(e.lastScore, -180);
    if (e.displayed === 'full' || e.pendingFull) e.lastTargetStep = 1;
    else if (e.displayed === 'lod' && e.displayedLodStep > 0) e.lastTargetStep = e.displayedLodStep as LodStep;
    else if (e.pendingLodStep > 0) e.lastTargetStep = e.pendingLodStep as LodStep;
    this.scheduler.notify({ type: 'meshInvalidated', entry: e, now });
  }

  private workerReadyCount(e: ChunkEntry): number {
    let count = 0;
    for (let i = 0; i < this.workers.length; i++) {
      if ((e.workerReadyMask & (1 << i)) !== 0) count++;
    }
    return count;
  }

  private clearDirtyIfUnchanged(e: ChunkEntry, dirtyToken: number) {
    if (e.dirtyToken === dirtyToken) e.dirty = false;
    // A neighbor may have arrived while this mesh was being built. Keep the
    // just-produced mesh visible, but immediately queue another pass with the
    // newer neighborhood instead of waiting for it to rank as a candidate
    // again.
    if (e.dirty && e.state === 'stored') this.rescheduleStoredIfFresh(e);
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
    if (!e.contentDigest) return null;
    const parts: string[] = [];
    let stable = true;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = this.chunks.get(this.key(e.cx + dx, e.cz + dz));
        if (!n) {
          parts.push('unknown');
          stable = false;
        } else if (n.state === 'absent') parts.push('missing');
        else if (n.contentDigest && n.state !== 'error') parts.push(`hash:${n.contentDigest}`);
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
    return (
      candidate === center ||
      !!candidate.contentDigest ||
      candidate.state === 'stored' ||
      candidate.displayed !== 'none' ||
      candidate.pendingFull ||
      candidate.pendingLod
    );
  }

  private ensureNeighborhoodWorkerData(e: ChunkEntry, now: number): boolean {
    let ready = true;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = this.chunks.get(this.key(e.cx + dx, e.cz + dz));
        if (!n || n.state === 'absent' || n.state === 'error') continue;
        if (!this.neighborNeedsWorkerData(e, n)) continue;
        this.keepWorkerData(n, now);
        if (n.state === 'stored') continue;
        ready = false;
        const priority = this.meshNeighborPriority(e, n, now);
        if (n.state === 'checking') this.queueHash(n.key, priority);
        else if (n.state === 'hashed') this.queueFetch(n.key, priority);
      }
    }
    return ready;
  }

  private meshNeighborPriority(center: ChunkEntry, neighbor: ChunkEntry, now: number): ChunkPriority {
    const distance = Math.hypot(center.cx - neighbor.cx, center.cz - neighbor.cz);
    const score = Number.isFinite(center.lastScore) ? center.lastScore : 0;
    return {
      tier: Math.min(center.lastTier, 1),
      score: score + distance * 0.1 + 6,
      updatedAt: now,
    };
  }

  // #endregion

  // #region Mesh requests

  private requestMesh(e: ChunkEntry, kind: MeshTaskKind, step: LodStep): boolean {
    if (e.pendingFull || e.pendingLod || this.meshJobs.size >= this.maxActiveMeshTasks() * 2) return false;
    const cache = this.neighborhoodCacheParts(e);
    if (!cache) {
      this.queueHash(e.key);
      return false;
    }
    const version = this.beginPendingMesh(e, kind, step, cache);
    const lookup = cache.stable
      ? getCachedMesh({ ...cache.parts, mode: kind, step: kind === 'full' ? 0 : step })
      : Promise.resolve(undefined);
    void lookup
      .then((hit) => {
        if (
          this.disposed ||
          this.chunks.get(e.key) !== e ||
          (kind === 'full' ? e.pendingFullVersion : e.pendingLodVersion) !== version
        ) {
          this.finishActiveMesh(version);
          return;
        }
        if (!hit) {
          if (kind === 'full') this.fullCacheMisses++;
          else this.lodCacheMisses++;
          this.startWorkerMeshing(e, kind, step, version);
          return;
        }
        this.clearPendingMesh(e, kind);
        if (this.shouldApplyMeshResult(e, kind, step, version)) {
          if (hit.mode === 'full') {
            this.fullCacheHits++;
            this.displayFull(e, hit.sections, version);
          } else {
            this.lodCacheHits++;
            this.displayLod(e, hit.mesh, version, step);
          }
          this.clearDirtyIfUnchanged(e, kind === 'full' ? e.pendingFullDirtyToken : e.pendingLodDirtyToken);
        }
        this.finishActiveMesh(version);
      })
      .catch((error) => {
        this.clearPendingMesh(e, kind);
        this.finishActiveMesh(version);
        this.lastMeshFailure(e, error);
      });
    return true;
  }

  private lastMeshFailure(e: ChunkEntry, error: unknown) {
    e.lastError = error instanceof Error ? error.message : String(error);
    this.markUnavailable(e, 'error', false, false);
    this.reportStats();
  }

  // #endregion

  // #region IO queues

  private queueHash(key: string, priority?: ChunkPriority) {
    this.queueIo('hash', key, priority);
  }

  private flushHashQueue() {
    this.flushIoQueue('hash');
  }

  private queueFetch(key: string, priority?: ChunkPriority) {
    this.queueIo('fetch', key, priority);
  }

  private flushFetchQueue() {
    this.flushIoQueue('fetch');
  }

  private queueIo(kind: IoQueueKind, key: string, priority?: ChunkPriority) {
    this.scheduler.notify({ type: kind === 'hash' ? 'hashNeeded' : 'fetchNeeded', key, priority });
    this.scheduleIoFlush(kind, 20);
  }

  private flushIoQueue(kind: IoQueueKind) {
    if (this.disposed || !this.workers.length) return;
    while (true) {
      const keys = this.nextIoBatch(kind);
      if (!keys.length) break;
      if (kind === 'hash') void this.fetchHashBatch(keys);
      else void this.fetchBatch(keys);
    }
    if (this.hasIoWork(kind)) this.scheduleIoFlush(kind, 50);
  }

  private nextIoBatch(kind: IoQueueKind): string[] {
    const work = this.scheduler.nextWork({
      now: performance.now(),
      activeHashBatches: this.checking,
      activeFetchBatches: this.fetching,
      activeMeshTasks: this.activeMeshTasks,
      maxMeshTasks: this.maxActiveMeshTasks(),
      entries: this.schedulerEntries(),
      entryFor: (key) => this.schedulerEntryForKey(key),
      includeHash: kind === 'hash',
      includeFetch: kind === 'fetch',
      includeMesh: false,
    });
    return kind === 'hash' ? (work.hashBatches[0] ?? []) : (work.fetchBatches[0] ?? []);
  }

  private hasIoWork(kind: IoQueueKind): boolean {
    const work = this.scheduler.nextWork({
      now: performance.now(),
      activeHashBatches: this.checking,
      activeFetchBatches: this.fetching,
      activeMeshTasks: this.activeMeshTasks,
      maxMeshTasks: this.maxActiveMeshTasks(),
      entries: this.schedulerEntries(),
      entryFor: (key) => this.schedulerEntryForKey(key),
      includeHash: false,
      includeFetch: false,
      includeMesh: false,
    });
    return kind === 'hash' ? work.hasHashWork : work.hasFetchWork;
  }

  private scheduleIoFlush(kind: IoQueueKind, delayMs: number) {
    if (this.disposed || this.ioTimer(kind)) return;
    this.setIoTimer(
      kind,
      setTimeout(() => {
        this.setIoTimer(kind, null);
        this.flushIoQueue(kind);
      }, delayMs),
    );
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
      e.contentDigest = null;
      e.resolution = undefined;
    }
    this.clearReadyFlags(e);
    this.invalidatePendingMeshes(e);
    if (state === 'absent') this.markNeighborsDirty(e);
    if (removeMesh) this.removeMesh(e);
  }

  private retryIo(e: ChunkEntry, error: unknown) {
    e.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 256);
    const retryable =
      error instanceof ResourceError
        ? error.retryable
        : error instanceof TypeError ||
          (error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name));
    if (!retryable) {
      this.markUnavailable(e, 'error', false, false);
      return;
    }
    e.retryAttempts++;
    if (error instanceof ResourceError && error.code === 'RESOURCE_VIEW_EXPIRED') e.resolution = undefined;
    this.activity.retries++;
    e.retryAt = performance.now() + Math.min(30000, 250 * 2 ** Math.min(7, e.retryAttempts - 1));
    e.state = e.contentDigest ? 'hashed' : 'checking';
    if (e.state === 'checking') this.queueHash(e.key);
    else this.queueFetch(e.key);
    debugLog('chunk-manager', 'io-retry', { key: e.key, attempt: e.retryAttempts, error: e.lastError });
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

  private releaseWorkerData(e: ChunkEntry): boolean {
    if (e.state !== 'stored') return false;
    if (performance.now() < e.workerKeepUntil) return false;
    if (e.workerPins > 0 || e.pendingFull || e.pendingLod || !e.contentDigest) return false;
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
    const memory =
      typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined;
    const copyBudget =
      memory !== undefined && memory <= 4
        ? 256
        : memory !== undefined && memory <= 8
          ? 512
          : TARGET_WORKER_RESIDENT_COPIES;
    const perWorkerBudget = Math.floor(copyBudget / Math.max(1, this.workers.length));
    return Math.max(MIN_WORKER_RESIDENT_COLUMNS, Math.min(MAX_WORKER_RESIDENT_COLUMNS, perWorkerBudget));
  }

  private releaseWorkerDataOverBudget() {
    const resident = [...this.chunks.values()].filter((e) => e.state === 'stored');
    const budget = this.maxWorkerResidentColumns();
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    const byteBudget =
      (memory !== undefined && memory <= 4 ? 128 : memory !== undefined && memory <= 8 ? 256 : 384) * 1024 ** 2;
    let bytes = resident.reduce((sum, e) => sum + e.estimatedColumnBytes * this.workerReadyCount(e), 0);
    if (resident.length <= budget && bytes <= byteBudget) return;
    const victims = resident
      .filter((e) => !e.pendingFull && !e.pendingLod && this.displaySatisfiesLastTarget(e) && !!e.contentDigest)
      .sort((a, b) => b.lastTier - a.lastTier || a.lastWantedAt - b.lastWantedAt || b.lastScore - a.lastScore);
    let count = resident.length;
    for (const e of victims) {
      if (count <= budget && bytes <= byteBudget) break;
      const released = e.estimatedColumnBytes * this.workerReadyCount(e);
      if (this.releaseWorkerData(e)) {
        count--;
        bytes -= released;
      }
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

  async refreshResources() {
    const rows = await resolveChunks(
      this.opts.world,
      this.opts.dimension,
      [...this.chunks.values()].map((e) => ({ cx: e.cx, cz: e.cz })),
      this.requests.signal,
    );
    if (this.disposed) return;
    for (const row of rows) {
      const entry = this.chunks.get(this.key(row.cx, row.cz));
      if (!entry) continue;
      if (row.missing) {
        this.markUnavailable(entry, 'absent', true);
        continue;
      }
      entry.resolution = row;
      if (row.contentDigest !== entry.contentDigest) {
        this.resetAfterSourceChange(entry);
        entry.contentDigest = row.contentDigest ?? null;
        entry.state = 'hashed';
        this.queueFetch(entry.key);
      }
    }
    await this.loadChunkSourceCoverage();
  }
  private handleFetchedResolution(payload: ResolvedChunk) {
    if (payload.head.renderRoot !== this.opts.renderRoot)
      throw new ResourceError('RESOURCE_VIEW_EXPIRED', 'chunk belongs to a different render root', true);
    const key = this.key(payload.cx, payload.cz);
    const e = this.chunks.get(key);
    if (!e || (e.state !== 'checking' && e.state !== 'hashed' && e.state !== 'fetching')) return;
    if (payload.missing) {
      this.markUnavailable(e, 'absent', true);
      return;
    }
    const oldContentHash = e.contentDigest;
    const newContentHash = payload.contentDigest ?? null;
    if (oldContentHash && newContentHash && oldContentHash !== newContentHash) {
      this.resetAfterSourceChange(e);
    }
    e.contentDigest = payload.contentDigest ?? null;
    e.resolution = payload;
    if (e.state !== 'fetching') e.state = 'hashed';
  }

  private async fetchHashBatch(keys: string[]) {
    if (this.disposed) return;
    const entries = keys
      .map((key) => this.chunks.get(key))
      .filter((e): e is ChunkEntry => !!e && e.state === 'checking');
    if (!entries.length) return;
    this.checking++;
    const started = performance.now();
    const opId = this.beginActiveOperation('hashFetch', `${entries.length} hashes`, this.hashFetchProfile);
    try {
      const seen = new Set<string>();
      const payloads = await resolveChunks(
        this.opts.world,
        this.opts.dimension,
        entries.map((e) => ({ cx: e.cx, cz: e.cz })),
        this.requests.signal,
      );
      if (this.disposed) return;
      let missing = 0;
      for (const payload of payloads) {
        seen.add(this.key(payload.cx, payload.cz));
        if (payload.missing) missing++;
        this.handleFetchedResolution(payload);
      }
      for (const e of entries) {
        if (!seen.has(this.key(e.cx, e.cz)) && e.state === 'checking') this.markUnavailable(e, 'absent', true);
      }
      debugLog('chunk-manager', 'hash-batch', { requested: entries.length, returned: payloads.length, missing });
    } catch (error) {
      if (this.disposed) return;
      debugLog('chunk-manager', 'hash-batch-error', {
        requested: entries.length,
        error: error instanceof Error ? error.message : String(error),
      });
      for (const e of entries) {
        if (e.state === 'checking') this.retryIo(e, error);
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
    const contentHash = payload.contentDigest ?? null;
    if (!contentHash) {
      this.markUnavailable(e, 'error', false, false);
      return;
    }
    const oldContentHash = e.contentDigest;
    if (oldContentHash && oldContentHash !== contentHash) {
      this.resetAfterSourceChange(e);
    }
    e.contentDigest = payload.contentDigest ?? null;
    e.state = 'decoding';
    e.decodingStartedAt = performance.now();
    e.retryAt = 0;
    e.retryAttempts = 0;
    e.lastError = undefined;
    e.workerReadyMask = 0;
    this.chunkBytesDecoded += payload.data.byteLength;
    this.activity.chunkDispatches++;
    this.activity.lastProgressAt = performance.now();
    const chunk = this.chunkBuffer(payload.data);
    const entities = payload.entities ? this.chunkBuffer(payload.entities) : undefined;
    if (payload.entities) this.chunkBytesDecoded += payload.entities.byteLength;
    this.sendChunkToWorkers(
      { type: 'chunk', key, contentDigest: contentHash, cx: e.cx, cz: e.cz, dimension: this.opts.dimensionDef },
      chunk,
      entities,
    );
  }

  private async fetchBatch(keys: string[]) {
    if (this.disposed) return;
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
      const unresolved = entries.filter((e) => !e.resolution);
      if (unresolved.length) {
        const refreshed = await resolveChunks(
          this.opts.world,
          this.opts.dimension,
          unresolved.map((e) => ({ cx: e.cx, cz: e.cz })),
          this.requests.signal,
        );
        if (this.disposed) return;
        for (const row of refreshed) this.handleFetchedResolution(row);
      }
      const payloads = await readChunks(
        entries.filter((e) => e.state === 'fetching').map((e) => e.resolution!),
        this.requests.signal,
      );
      if (this.disposed) return;
      let missing = 0;
      let bytes = 0;
      for (const outcome of payloads) {
        const key = this.key(outcome.cx, outcome.cz);
        seen.add(key);
        if ('error' in outcome) {
          const entry = this.chunks.get(key);
          if (entry?.state === 'fetching') this.retryIo(entry, outcome.error);
          continue;
        }
        const { payload, resolution } = outcome;
        this.handleFetchedResolution(resolution);
        if (!payload.data || payload.missing) missing++;
        else bytes += payload.data.byteLength;
        this.handleFetchedChunk(payload);
      }
      for (const e of entries) {
        if (!seen.has(this.key(e.cx, e.cz)) && e.state === 'fetching') this.markUnavailable(e, 'absent', true);
      }
      debugLog('chunk-manager', 'chunk-batch', {
        requested: entries.length,
        returned: payloads.length,
        missing,
        bytes,
      });
    } catch (error) {
      if (this.disposed) return;
      debugLog('chunk-manager', 'chunk-batch-error', {
        requested: entries.length,
        error: error instanceof Error ? error.message : String(error),
      });
      for (const e of entries) {
        if (e.state === 'fetching') this.retryIo(e, error);
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
        if (!e) {
          this.broadcast({ type: 'drop', key: msg.key });
          return;
        }
        if ((e.state !== 'decoding' && e.state !== 'stored') || e.contentDigest !== msg.contentDigest) break;
        e.workerReadyMask |= 1 << workerIndex;
        e.estimatedColumnBytes = Math.max(e.estimatedColumnBytes, msg.profile?.estimatedColumnBytes ?? 0);
        e.biome = msg.biome;
        e.surfaceY = msg.surfaceY;
        if (e.workerReadyMask !== this.allWorkersMask()) break;
        e.state = 'stored';
        e.decodingStartedAt = undefined;
        if (e.readyContentDigest !== msg.contentDigest) {
          e.readyContentDigest = msg.contentDigest;
          this.markNeighborsDirty(e);
        }
        this.scheduler.notify({ type: 'chunkStored', entry: e, now: performance.now() });
        this.flushMeshQueue();
        this.reportStats();
        break;
      }
      case 'chunkError': {
        const e = this.chunks.get(msg.key);
        if (e && e.contentDigest === msg.contentDigest) this.lastMeshFailure(e, new Error(msg.error));
        console.warn('chunk parse error', msg.key, msg.error);
        break;
      }
      case 'meshError': {
        this.finishMeshDiagnostic(msg.version, undefined);
        this.finishActiveMesh(msg.version);
        const e = this.chunks.get(msg.key);
        if (e && (msg.kind === 'full' ? e.pendingFullVersion : e.pendingLodVersion) === msg.version) {
          this.lastMeshFailure(e, new Error(msg.error));
          this.reportStats();
        }
        console.warn('chunk mesh error', msg.key, msg.kind, msg.error);
        break;
      }
      case 'meshResult': {
        this.finishMeshDiagnostic(msg.version, msg.profile?.meshMs);
        this.finishActiveMesh(msg.version);
        const e = this.chunks.get(msg.key);
        if (!e || e.pendingFullVersion !== msg.version) return;
        const cacheParts = e.pendingFullCacheParts;
        const dirtyToken = e.pendingFullDirtyToken;
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
        if (cacheParts)
          void putCachedMesh({ ...cacheParts, mode: 'full', step: 0 }, { mode: 'full', sections: msg.sections }).catch(
            () => {},
          );
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
        if (cacheParts)
          void putCachedMesh({ ...cacheParts, mode: 'lod', step }, { mode: 'lod', mesh: msg.mesh }).catch(() => {});
        if (!shouldDisplay) {
          this.rescheduleStoredIfFresh(e);
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

  // #endregion

  // #region Section visibility

  private visibilityAllows(mask: number, from: number, to: number): boolean {
    return Math.floor(mask / 2 ** (from * 6 + to)) % 2 >= 1;
  }

  private invalidateDisplayedChunkKeys() {
    this.displayedChunkKeyCacheDirty = true;
  }

  private setSectionVisible(section: FullSectionRender, visible: boolean) {
    if (section.visible === visible) return;
    section.visible = visible;
    for (const mesh of section.meshes) mesh.visible = visible;
    this.sectionVisibilityRevision++;
    this.invalidateDisplayedChunkKeys();
  }

  private setAllFullSectionsVisible(visible: boolean) {
    for (const section of this.fullSectionIndex.values()) this.setSectionVisible(section, visible);
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
      this.setSectionVisible(section, this.fullSectionWithinTopClip(section.sy));
    }
  }

  private applyLodTopClip() {
    const visible = this.lodVisibleForTopClip();
    for (const e of this.chunks.values()) {
      if (e.displayed !== 'lod' || !e.group || e.group.visible === visible) continue;
      e.group.visible = visible;
      this.invalidateDisplayedChunkKeys();
    }
  }

  private applyTopClipVisibility() {
    if (this.topDownView) this.applyFullSectionTopClip();
    else this.setAllFullSectionsVisible(true);
    this.applyLodTopClip();
  }

  private updateFullSectionVisibility(camera: ChunkSchedulerCamera) {
    if (!this.fullSectionIndex.size) return;
    if (this.topDownView) return;
    const startCx = Math.floor(camera.position.x / 16);
    const startSy = Math.floor(camera.position.y / 16);
    const startCz = Math.floor(camera.position.z / 16);
    const startKey = this.sectionKey(startCx, startSy, startCz);
    const startEntry = this.chunks.get(this.key(startCx, startCz));
    const aboveSurface = !!startEntry && camera.position.y >= startEntry.surfaceY + 2;
    if (
      this.lastVisibilityRevision === this.visibilityRevision &&
      this.lastVisibilityStartKey === startKey &&
      this.lastVisibilityAboveSurface === aboveSurface
    )
      return;
    this.lastVisibilityRevision = this.visibilityRevision;
    this.lastVisibilityStartKey = startKey;
    this.lastVisibilityAboveSurface = aboveSurface;
    const start = this.fullSectionIndex.get(startKey);
    if (!start || start.visibility <= 0) {
      this.setAllFullSectionsVisible(true);
      return;
    }
    if (aboveSurface) {
      this.setAllFullSectionsVisible(true);
      return;
    }
    if (start.visibility === SECTION_VISIBILITY_ALL) {
      this.setAllFullSectionsVisible(true);
      return;
    }

    const visible = this.visibleSectionKeys;
    const queueSections = this.visibilityQueueSections;
    const queueEntries = this.visibilityQueueEntries;
    const entryMasks = this.visibilityEntryMasks;
    visible.clear();
    entryMasks.clear();
    entryMasks.set(start.key, (1 << SECTION_VISIBILITY_DIRS.length) - 1);
    queueSections.length = 1;
    queueEntries.length = 1;
    queueSections[0] = start;
    queueEntries[0] = -1;
    let head = 0;
    visible.add(start.key);

    while (head < queueSections.length) {
      const section = queueSections[head];
      const entry = queueEntries[head++];
      const mask = section.visibility;
      for (let dir = 0; dir < SECTION_VISIBILITY_DIRS.length; dir++) {
        if (entry >= 0 && !this.visibilityAllows(mask, entry, dir)) continue;
        const delta = SECTION_NEIGHBOR[dir];
        const next = this.fullSectionIndex.get(
          this.sectionKey(section.cx + delta[0], section.sy + delta[1], section.cz + delta[2]),
        );
        if (!next) continue;
        visible.add(next.key);
        // Visibility belongs to an entrance, not just to the section. Separate
        // tunnels can be reached from different sides at different BFS depths.
        // A solid neighbor is visible at its boundary but cannot transmit sight.
        if (next.visibility === 0) continue;
        const entrance = SECTION_OPPOSITE[dir];
        const entered = entryMasks.get(next.key) ?? 0;
        if (entered & (1 << entrance)) continue;
        entryMasks.set(
          next.key,
          next.visibility === SECTION_VISIBILITY_ALL
            ? (1 << SECTION_VISIBILITY_DIRS.length) - 1
            : entered | (1 << entrance),
        );
        queueSections.push(next);
        queueEntries.push(entrance);
      }
    }

    for (const section of this.fullSectionIndex.values()) this.setSectionVisible(section, visible.has(section.key));
    // Do not retain removed section objects/GPU geometry through the scratch queue.
    queueSections.length = 0;
    queueEntries.length = 0;
  }

  private specialRenderRadiusChunks(): number {
    // Scheduler presets map this radius from potato (2) through extreme (6).
    // It deliberately follows the full-detail disk rather than view distance.
    return Math.max(0, Math.floor(this.opts.scheduling?.criticalNearRadiusChunks ?? 4));
  }

  private updateSpecialRenderVisibility(camera: ChunkSchedulerCamera) {
    const radius = this.specialRenderRadiusChunks();
    const centerCx = Math.floor(camera.position.x / 16);
    const centerCz = Math.floor(camera.position.z / 16);
    if (
      this.lastSpecialVisibilityRevision === this.sectionVisibilityRevision &&
      this.lastSpecialCenterCx === centerCx &&
      this.lastSpecialCenterCz === centerCz &&
      this.lastSpecialRadius === radius
    )
      return;
    const radius2 = radius * radius;
    let changed = false;
    for (const section of this.fullSectionIndex.values()) {
      const dx = section.cx - centerCx;
      const dz = section.cz - centerCz;
      const allowed = section.visible && dx * dx + dz * dz <= radius2;
      for (const mesh of section.specialMeshes) {
        if (mesh.visible === allowed) continue;
        mesh.visible = allowed;
        changed = true;
      }
    }
    this.lastSpecialVisibilityRevision = this.sectionVisibilityRevision;
    this.lastSpecialCenterCx = centerCx;
    this.lastSpecialCenterCz = centerCz;
    this.lastSpecialRadius = radius;
    if (changed) this.invalidateDisplayedChunkKeys();
  }

  // #endregion

  // #region Mesh display

  private displayFull(e: ChunkEntry, sections: SectionMeshMsg[], version: number) {
    this.activity.meshApplications++;
    this.activity.lastProgressAt = performance.now();
    this.removeMesh(e);
    const group = new THREE.Group();
    let meshBytes = 0;
    for (const s of sections) {
      const sectionMeshes: THREE.Mesh[] = [];
      const specialMeshes: THREE.Mesh[] = [];
      const sectionVisible = this.fullSectionWithinTopClip(s.sy);
      for (const [layer, buffers] of Object.entries(s.layers) as [RenderLayer, MeshBuffers][]) {
        if (!this.hasRenderableGeometry(buffers)) continue;
        const built = this.buildGeometry(buffers, true);
        meshBytes += built.bytes;
        const mesh = new THREE.Mesh(built.geometry, this.materials[layer]);
        mesh.position.set(e.cx * 16, s.sy * 16, e.cz * 16);
        mesh.frustumCulled = true;
        mesh.visible = sectionVisible;
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        group.add(mesh);
        sectionMeshes.push(mesh);
        if (layer === 'specialOpaque' || layer === 'specialCutout' || layer === 'specialTranslucent')
          specialMeshes.push(mesh);
      }
      const section: FullSectionRender = {
        key: this.sectionKey(e.cx, s.sy, e.cz),
        cx: e.cx,
        sy: s.sy,
        cz: e.cz,
        visibility: s.visibility ?? SECTION_VISIBILITY_ALL,
        meshes: sectionMeshes,
        specialMeshes,
        visible: sectionVisible,
      };
      e.fullSections.push(section);
      this.fullSectionIndex.set(section.key, section);
    }
    if (e.fullSections.length > 0) {
      this.visibilityRevision++;
      this.sectionVisibilityRevision++;
    }
    e.meshBytes = meshBytes;
    this.displayedMeshBytes += e.meshBytes;
    if (group.children.length > 0) {
      this.root.add(group);
      e.group = group;
    }
    if (this.latestCamera) this.updateSpecialRenderVisibility(this.latestCamera);
    e.displayed = 'full';
    e.displayedVersion = version;
    e.displayedLodStep = 0;
    e.fullReady = meshBytes > 0;
    this.invalidateDisplayedChunkKeys();
    this.scheduler.notify({ type: 'meshDisplayed', entry: e, kind: 'full', step: 1, version, now: performance.now() });
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
    this.activity.meshApplications++;
    this.activity.lastProgressAt = performance.now();
    this.removeMesh(e);
    if (meshBuffers && this.hasRenderableGeometry(meshBuffers)) {
      const built = this.buildGeometry(meshBuffers, false);
      e.meshBytes = built.bytes;
      this.displayedMeshBytes += e.meshBytes;
      const mesh = new THREE.Mesh(built.geometry, this.materials.lod);
      mesh.position.set(e.cx * 16, 0, e.cz * 16);
      mesh.frustumCulled = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.visible = this.lodVisibleForTopClip();
      this.root.add(mesh);
      e.group = mesh;
    } else {
      e.meshBytes = 0;
    }
    e.displayed = 'lod';
    e.displayedVersion = version;
    e.displayedLodStep = step;
    e.lodReadyStep = e.meshBytes > 0 ? step : 0;
    this.invalidateDisplayedChunkKeys();
    this.scheduler.notify({
      type: 'meshDisplayed',
      entry: e,
      kind: 'lod',
      step: step as LodStep,
      version,
      now: performance.now(),
    });
    if (e.lastTargetStep === 1) {
      this.flushMeshQueue();
    }
    debugLog('chunk-manager', 'display-lod', {
      key: e.key,
      step,
      meshBytes: e.meshBytes,
      visible: e.group?.visible ?? false,
    });
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
    if (b.animations) g.setAttribute('animationId', new THREE.BufferAttribute(b.animations, 1, false));
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
      bytes: meshByteLength(b),
    };
  }

  private removeMesh(e: ChunkEntry) {
    const hadSections = e.fullSections.length > 0;
    const hadDisplay = e.displayed !== 'none' || e.group !== null;
    for (const section of e.fullSections) this.fullSectionIndex.delete(section.key);
    e.fullSections.length = 0;
    if (e.group) {
      this.root.remove(e.group);
      e.group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    }
    this.displayedMeshBytes = Math.max(0, this.displayedMeshBytes - e.meshBytes);
    e.meshBytes = 0;
    e.group = null;
    e.displayed = 'none';
    e.displayedLodStep = 0;
    e.lodReadyStep = 0;
    e.fullReady = false;
    if (hadSections) {
      this.visibilityRevision++;
      this.sectionVisibilityRevision++;
    }
    if (hadDisplay) this.invalidateDisplayedChunkKeys();
  }

  // #endregion

  // #region Stats

  private entryHasVisibleMesh(e: ChunkEntry): boolean {
    return this.entryHasDisplayedMesh(e);
  }

  private entryHasDisplayedMesh(e: ChunkEntry): boolean {
    if (!e.group || !e.group.visible) return false;
    if (e.displayed === 'lod') {
      return e.group instanceof THREE.Mesh
        ? e.group.visible
        : e.group.children.some((child) => child instanceof THREE.Mesh && child.visible);
    }
    if (e.displayed !== 'full') return false;
    return e.fullSections.some((section) => section.meshes.some((mesh) => mesh.visible));
  }

  private collectRenderStats(): ChunkRenderStats {
    let nbt = 0,
      lodReady = 0,
      lodRendered = 0,
      fullReady = 0,
      fullRendered = 0;
    for (const e of this.chunks.values()) {
      if (e.state === 'decoding' || e.state === 'stored') nbt++;
      if (e.lodReadyStep > 0) lodReady++;
      if (e.displayed === 'lod' && this.entryHasVisibleMesh(e)) lodRendered++;
      if (e.fullReady) fullReady++;
      if (e.displayed === 'full' && this.entryHasVisibleMesh(e)) fullRendered++;
    }
    return { trackedChunks: this.chunks.size, nbt, lodReady, lodRendered, fullReady, fullRendered };
  }

  private collectProfileStats(): ChunkProfileStats {
    return {
      workerCount: this.workers.length,
      activeMeshTasks: this.activeMeshTasks,
      workerChunkCopies: [...this.chunks.values()].reduce((sum, e) => sum + this.workerReadyCount(e), 0),
      estimatedWorkerBytes: [...this.chunks.values()].reduce(
        (sum, e) => sum + this.workerReadyCount(e) * e.estimatedColumnBytes,
        0,
      ),
      cacheLookups: [...this.meshJobs.values()].filter((job) => job.phase === 'cache').length,
      errorChunks: [...this.chunks.values()].filter((e) => e.state === 'error').length,
      retryingChunks: [...this.chunks.values()].filter((e) => e.retryAttempts > 0 && e.state !== 'error').length,
      displayedMeshBytes: this.displayedMeshBytes,
      chunkBytesDecoded: this.chunkBytesDecoded,
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
    this.schedulerStats = this.scheduler.syncStats(renderStats, this.collectProfileStats());
    return this.schedulerStats;
  }

  private reportStats(force = false) {
    if (!this.onStats) return;
    const now = performance.now();
    if (!force && now - this.lastStatsReport < STATS_REPORT_INTERVAL_MS) return;
    this.lastStatsReport = now;
    this.onStats(this.syncSchedulerStats());
  }

  // #endregion

  // #region Cleanup

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.requests.abort();
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.workerRestartTimer) clearTimeout(this.workerRestartTimer);
    this.coverageSeq++;
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
    this.meshJobs.clear();
    this.versionWorker.clear();
    this.meshDiagnosticByVersion.clear();
    this.activeDiagnostics.clear();
    this.visibleSectionKeys.clear();
    this.visibilityEntryMasks.clear();
    this.visibilityQueueSections.length = 0;
    this.visibilityQueueEntries.length = 0;
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.workerLoads = [];
  }

  // #endregion
}
