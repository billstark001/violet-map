import { chunkRetryDelayMs, chunkWorkIdle, MESH_PREPARATIONS_PER_WORKER } from '../scheduling/chunkPolicy';
import type { ViewerResourceBudget } from '../scheduling/resourceBudget';
import { selectResidencyReleases, workerDataReleasable, WORKER_NEIGHBOR_HOLD_MS } from '../scheduling/chunkResidency';
import { EMPTY_CHUNK_DISPLAY, type ChunkDisplayState } from '../view/terrain';
import { ChunkIoBatch } from './chunkIo';
import type { ChunkDisplay } from './chunkDisplay';
import { LoadingMetrics } from '../diagnostics/loadingMetrics';

import { type ChunkCoverage, type ChunkPayload } from '@violet-map/core/contracts';
import type { DimensionDef } from '@violet-map/core/domain';
import { ResourceError } from '@violet-map/core/resources';

import type { ViewState } from '../view/state';
import type { TopClipRange } from '../view/worldGeometry';
import { resolveChunks, readChunks, fetchChunkSourceCoverage, type ResolvedChunk } from '../api';
import { debugLog, isDebugLoggingEnabled } from '../logger';
import { getCachedMesh, putCachedMesh, type MeshCacheKeyParts } from '../resources/meshCache';
import { type TerrainMesh } from '../view/terrain';
import { chunkKey, type WorkerInit, type WorkerRequest, type WorkerResponse } from '../worker/protocol';
import { ChunkScheduler } from '../scheduling/chunkScheduler';
import {
  type ChunkDemand,
  type ChunkSchedulerDiagnosticSnapshot,
  type ChunkSchedulerEntry,
  type ChunkSchedulingTuning,
  type ChunkState,
  type SchedulerAction,
} from '../scheduling/contracts';
import { LOD_STEPS, type LodStep, type MeshTaskKind } from '../view/terrain';
import {
  EMPTY_CHUNK_SCHEDULER_STATS,
  type ChunkProfileStats,
  type ChunkRenderStats,
  type ChunkSchedulerStats,
} from '../diagnostics/contracts';

const UPDATE_INTERVAL_MS = 80;
const STATS_REPORT_INTERVAL_MS = 100;

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
  demand: Readonly<ChunkDemand> | null;
  tracker: import('../scheduling/contracts').SchedulerCellDiagnostic | null;
  precision: number | null;
  height: number | null;
  bump: number | null;
  retryAt: number;
  lastError?: string;
}

export interface ChunkRuntimeDiagnosticSnapshot {
  schema: 2;
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

interface ChunkEntry extends ChunkSchedulerEntry, ChunkDisplayState {
  ioRequest?: symbol;
  retryAttempts: number;
  lastError?: string;
  readyContentDigest?: string;
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
  dirtyToken: number;
  biome: string;
  surfaceY: number;
  contentDigest: string | null;
  resolution?: ResolvedChunk;
}

interface MeshJob {
  diagnosticId?: number;
  entry: ChunkEntry;
  kind: MeshTaskKind;
  step: LodStep;
  phase: 'cache' | 'waiting-input' | 'ready' | 'worker';
  startedAt: number;
  dependencies: ChunkEntry[];
}

export interface ChunkRuntimeOptions {
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

export class ChunkRuntime {
  private readonly metrics = new LoadingMetrics();
  private workers: Worker[] = [];
  private workerLoads: number[] = [];
  private versionWorker = new Map<number, number>();
  private readonly chunks = new Map<string, ChunkEntry>();
  private readonly scheduler: ChunkScheduler;
  private checking = 0;
  private hashTimer: ReturnType<typeof setTimeout> | null = null;
  private fetching = 0;
  private fetchTimer: ReturnType<typeof setTimeout> | null = null;
  private ioWakeAt = { hash: Infinity, fetch: Infinity };
  private deferredMeshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private activeMeshTasks = 0;
  private inFlightMeshVersions = new Set<number>();
  private meshJobs = new Map<number, MeshJob>();
  private meshFlushScheduled = false;
  private meshFlushing = false;
  private healthTimer?: ReturnType<typeof setInterval>;
  private workerRestartTimer?: ReturnType<typeof setTimeout>;
  private workerRestarts = 0;
  private versionCounter = 0;
  private lastStatsReport = -Infinity;
  private chunkBytesDecoded = 0;
  private activity = { chunkDispatches: 0, meshRequests: 0, meshApplications: 0, retries: 0, lastProgressAt: 0 };
  private fullCacheHits = 0;
  private fullCacheMisses = 0;
  private lodCacheHits = 0;
  private lodCacheMisses = 0;
  private schedulerStats: ChunkSchedulerStats = { ...EMPTY_CHUNK_SCHEDULER_STATS };
  private lastUpdate = 0;
  private disposed = false;
  private readonly requests = new AbortController();
  private coverageSeq = 0;
  private refreshSeq = 0;
  private chunkCoverage: ChunkSourceCoverage | null = null;
  onStats?: (s: ChunkSchedulerStats) => void;

  // #region Lifecycle

  constructor(
    private readonly terrain: ChunkDisplay,
    private readonly initPayload: Omit<WorkerInit, 'type'>,
    private opts: ChunkRuntimeOptions,
    private readonly budget: ViewerResourceBudget,
  ) {
    this.scheduler = new ChunkScheduler(this.schedulerOptions());
    void this.loadChunkSourceCoverage();
    const workerCount = this.budget.meshWorkers;
    for (let i = 0; i < workerCount; i++) {
      this.createWorker(i);
    }
    this.healthTimer = setInterval(() => this.checkWorkerHealth(), 1000);
  }

  // #endregion

  // #region Keys and workers

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
    const count = this.budget.meshWorkers;
    const affected = new Set([...this.meshJobs.values()].map((job) => job.entry));
    for (const [version, job] of this.meshJobs) {
      this.clearPendingMesh(job.entry, job.kind);
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
        this.queueIo('fetch', e.key);
      }
    }
    debugLog('chunk-runtime', 'worker-restart', { reason, count: this.workerRestarts });
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
        this.flushIoQueue('hash');
        this.flushIoQueue('fetch');
        this.flushMeshQueue();
      },
      Math.min(5000, 250 * this.workerRestarts),
    );
  }

  private key(cx: number, cz: number) {
    return chunkKey(this.opts.world, this.opts.dimension, cx, cz);
  }
  private allWorkersMask(): number {
    return (1 << this.workers.length) - 1;
  }
  private sendToWorker(workerIndex: number, msg: WorkerRequest, transfer: Transferable[] = []) {
    const worker = this.workers[workerIndex];
    if (!worker) throw new Error(`Worker dispatch selected unavailable Worker ${workerIndex}`);
    worker.postMessage(msg, transfer);
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
      debugLog('chunk-runtime', 'coverage-loaded', {
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
      debugLog('chunk-runtime', 'coverage-error', {
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
  setScheduling(scheduling: ChunkSchedulingTuning | undefined) {
    this.opts = { ...this.opts, scheduling };
  }

  /** A JSON-safe, point-in-time view used by the settings diagnosis export. */
  diagnosticSnapshot(): ChunkRuntimeDiagnosticSnapshot {
    const now = performance.now();
    const stats = this.syncSchedulerStats();
    const coverage = this.chunkCoverage;
    const chunks = [...this.chunks.values()]
      .sort((a, b) => a.cz - b.cz || a.cx - b.cx)
      .map((entry): ChunkEntryDiagnosticSnapshot => {
        const tracker = this.scheduler.view.diagnosticCell(entry.cx, entry.cz);
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
          demand: this.scheduler.demandFor(entry.key) ?? null,
          tracker,
          precision: tracker?.precision ?? null,
          height: tracker?.height ?? null,
          bump: tracker?.bump ?? null,
          retryAt: entry.retryAt ?? 0,
          lastError: entry.lastError,
        };
      });

    return {
      schema: 2,
      capturedAt: new Date().toISOString(),
      world: `${this.opts.sourceScope}:${this.opts.world}`,
      dimension: this.opts.dimension,
      renderKey: this.opts.renderKey,
      topDownView: this.terrain.view.topDownView,
      topClipRange: { ...this.terrain.view.topClipRange },
      scheduling: this.scheduler.diagnosticSnapshot(now, this.chunks),
      stats: { ...stats, diagnostics: [...stats.diagnostics] },
      workers: {
        count: this.workers.length,
        loads: [...this.workerLoads],
        activeMeshTasks: this.activeMeshTasks,
        checking: this.checking,
        fetching: this.fetching,
        cacheLookups: [...this.meshJobs.values()].filter((job) => job.phase === 'cache').length,
        waitingMeshes: [...this.meshJobs.values()].filter(
          (job) => job.phase === 'waiting-input' || job.phase === 'ready',
        ).length,
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

  private schedulerOptions() {
    return {
      disableLod: this.opts.disableLod === true,
      scheduling: this.opts.scheduling,
    };
  }

  displayedChunkKeys(): ReadonlySet<string> {
    return this.terrain.displayedChunkKeys();
  }

  private applySchedulerAction(action: SchedulerAction) {
    switch (action.type) {
      case 'wantChunk':
        this.ensureEntry(action.cx, action.cz);
        return;
      case 'dropChunk': {
        const e = this.chunks.get(action.key);
        if (e) this.dropEntry(action.key, e);
        return;
      }
    }
  }

  /** 每帧调用（内部节流）。 */
  update(view: ViewState, now: number, force = false) {
    this.terrain.setView(view);
    if (!force && now - this.lastUpdate < UPDATE_INTERVAL_MS) return;
    this.lastUpdate = now;

    const entriesBefore = this.chunks.size;
    const frame = this.scheduler.tick({
      view,
      now,
      options: this.schedulerOptions(),
      keyFor: (cx, cz) => this.key(cx, cz),

      cellInfoFor: (cx, cz) => ({
        topMapSurfaceY: this.opts.topMapSurfaceYAt?.(cx, cz) ?? null,
        hasChunkSource: this.hasChunkSourceAt(cx, cz),
      }),
      entries: this.chunks,
    });

    for (const action of frame.actions) this.applySchedulerAction(action);
    this.applyResidencyPlan(frame.keepKeys, now);
    this.metrics.checkDelayed(now);
    this.flushMeshQueue();
    this.flushIoQueue('hash');
    this.flushIoQueue('fetch');
    this.flushMeshQueue();
    this.terrain.updateVisibility(frame.fullDetailKeys);
    if (isDebugLoggingEnabled()) {
      this.syncSchedulerStats();
      debugLog('chunk-runtime', 'update', {
        world: this.opts.world,
        dimension: this.opts.dimension,
        topDownView: view.mode === 'top',
        topClipRange: this.terrain.view.topClipRange,
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

  private ensureEntry(cx: number, cz: number): ChunkEntry {
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
      meshBytes: 0,
      biome: 'minecraft:plains',
      surfaceY: 64,
      contentDigest: null,
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
    if (this.disposed || !this.workers.length || this.meshFlushing) return;
    this.meshFlushing = true;
    try {
      const now = performance.now();
      for (const [version, job] of this.meshJobs) {
        if (job.phase === 'cache' || job.phase === 'worker') continue;
        if (
          !this.scheduler.shouldAcceptMeshResult({
            entry: job.entry,
            kind: job.kind,
            step: job.step,
            version,
            now,
          })
        ) {
          this.clearPendingMesh(job.entry, job.kind);
          this.finishActiveMesh(version);
          continue;
        }
        job.phase = this.ensureNeighborhoodWorkerData(job.entry, now) ? 'ready' : 'waiting-input';
      }
      const dispatch = this.scheduler.dispatchWorkers({
        now,
        activeTasks: this.activeMeshTasks,
        maxTasks: this.maxActiveMeshTasks(),
        workerLoads: this.workerLoads,
        entries: this.chunks,
        ready: [...this.meshJobs]
          .filter(([, job]) => job.phase === 'ready')
          .map(([version, job]) => ({
            entry: job.entry,
            kind: job.kind,
            step: job.step,
            version,
          })),
      });
      for (const version of dispatch.discard) {
        const job = this.meshJobs.get(version)!;
        this.clearPendingMesh(job.entry, job.kind);
        this.finishActiveMesh(version);
      }
      for (const { task, workerIndex } of dispatch.start)
        if (!this.dispatchWorkerMesh(task.entry as ChunkEntry, task.kind, task.step, task.version, workerIndex)) return;
      while (this.meshJobs.size < this.maxActiveMeshTasks() * MESH_PREPARATIONS_PER_WORKER) {
        const work = this.scheduler.nextWork({
          now: performance.now(),
          activeHashBatches: this.checking,
          activeFetchBatches: this.fetching,
          activeMeshTasks: this.meshJobs.size,
          maxMeshTasks: this.maxActiveMeshTasks() * MESH_PREPARATIONS_PER_WORKER,
          entries: this.chunks,
          includeHash: false,
          includeFetch: false,
          includeMesh: true,
        });
        if (!work.meshTasks.length) break;
        let started = false;
        for (const task of work.meshTasks) {
          const entry = this.chunks.get(task.key);
          if (entry) started = this.requestMesh(entry, task.kind, task.step) || started;
        }
        if (!started) break;
      }
      this.flushIoQueue('hash');
      this.flushIoQueue('fetch');
    } finally {
      this.meshFlushing = false;
    }
  }

  private maxActiveMeshTasks(): number {
    return this.workers.length;
  }

  private finishActiveMesh(version: number, durationMs?: number) {
    const job = this.meshJobs.get(version);
    if (!job) return;
    if (job.diagnosticId !== undefined) this.metrics.finish(job.diagnosticId, durationMs);
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

  private markWorkerMesh(version: number, workerIndex: number) {
    this.activity.meshRequests++;
    this.activeMeshTasks++;
    this.inFlightMeshVersions.add(version);
    this.workerLoads[workerIndex]++;
    this.versionWorker.set(version, workerIndex);
  }

  private deferMesh(entry: ChunkEntry) {
    this.scheduler.notify({ type: 'meshDeferred', key: entry.key, now: performance.now() });
    const demand = this.scheduler.demandFor(entry.key);
    if (!demand || this.deferredMeshTimers.has(entry.key)) return;
    const timer = setTimeout(
      () => {
        this.deferredMeshTimers.delete(entry.key);
        if (!this.disposed) this.flushMeshQueue();
      },
      Math.max(0, demand.meshRetryAt - performance.now()),
    );
    this.deferredMeshTimers.set(entry.key, timer);
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

  private recoverMissingWorkerInput(e: ChunkEntry) {
    this.scheduler.notify({ type: 'dependencyNeeded', centerKey: e.key, key: e.key, now: performance.now() });
    if (e.state === 'stored') {
      e.workerReadyMask = 0;
      e.state = 'hashed';
    }
    if (e.state === 'checking') this.queueIo('hash', e.key);
    else if (e.state === 'hashed') this.queueIo('fetch', e.key);
    else if (e.state === 'fetching') this.flushIoQueue('fetch');
    this.deferMesh(e);
    this.reportStats();
  }

  private dispatchWorkerMesh(
    e: ChunkEntry,
    kind: MeshTaskKind,
    step: LodStep,
    version: number,
    workerIndex: number,
  ): boolean {
    const job = this.meshJobs.get(version)!;
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
    this.markWorkerMesh(version, workerIndex);
    const op = kind === 'full' ? 'fullMesh' : 'lodMesh';
    const detail = kind === 'full' ? e.key : `${e.key} LOD ${step}`;
    job.diagnosticId = this.metrics.begin(op, detail);
    try {
      if (kind === 'full') this.sendToWorker(workerIndex, { type: 'mesh', key: e.key, version });
      else this.sendToWorker(workerIndex, { type: 'lod', key: e.key, step, version });
      return true;
    } catch (error) {
      this.recoverWorkers(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  // #endregion

  // #region Chunk state and cache keys

  private removeDisplayedMesh(entry: ChunkEntry) {
    this.terrain.remove(entry.key);
    Object.assign(entry, EMPTY_CHUNK_DISPLAY);
  }

  private dropEntry(key: string, e: ChunkEntry) {
    if (!chunkWorkIdle(e)) throw new Error('cannot apply eviction to a chunk with active work: ' + key);
    this.removeDisplayedMesh(e);
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
        this.scheduler.notify({ type: 'dependencyNeeded', centerKey: e.key, key: n.key, now });
        if (n.state === 'checking') this.queueIo('hash', n.key);
        else if (n.state === 'hashed') this.queueIo('fetch', n.key);
      }
    }
    return ready;
  }

  // #endregion

  // #region Mesh requests

  private requestMesh(e: ChunkEntry, kind: MeshTaskKind, step: LodStep): boolean {
    if (e.pendingFull || e.pendingLod || this.meshJobs.size >= this.maxActiveMeshTasks() * MESH_PREPARATIONS_PER_WORKER)
      return false;
    const cache = this.neighborhoodCacheParts(e);
    if (!cache) {
      this.queueIo('hash', e.key);
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
          this.meshJobs.get(version)!.phase = 'waiting-input';
          this.flushMeshQueue();
          return;
        }
        this.clearPendingMesh(e, kind);
        if (
          this.scheduler.shouldAcceptMeshResult({
            entry: e,
            kind: kind,
            step: step,
            version: version,
            now: performance.now(),
          })
        ) {
          if (hit.mode === 'full') {
            this.fullCacheHits++;
            this.applyMesh(e, { mode: 'full', sections: hit.sections }, version, 1);
          } else {
            this.lodCacheHits++;
            this.applyMesh(e, { mode: 'lod', mesh: hit.mesh }, version, step as LodStep);
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

  private queueIo(kind: IoQueueKind, key: string) {
    this.scheduler.notify({ type: kind === 'hash' ? 'hashNeeded' : 'fetchNeeded', key });
    this.scheduleIoFlush(kind, Math.max(20, (this.chunks.get(key)?.retryAt ?? 0) - performance.now()));
  }

  private flushIoQueue(kind: IoQueueKind) {
    if (this.disposed || !this.workers.length) return;
    while (true) {
      const now = performance.now();
      const work = this.scheduler.nextWork({
        now,
        activeHashBatches: this.checking,
        activeFetchBatches: this.fetching,
        activeMeshTasks: this.activeMeshTasks,
        maxMeshTasks: this.maxActiveMeshTasks(),
        entries: this.chunks,
        includeHash: kind === 'hash',
        includeFetch: kind === 'fetch',
        includeMesh: false,
      });
      const keys = (kind === 'hash' ? work.hashBatches[0] : work.fetchBatches[0]) ?? [];
      if (!keys.length) {
        const wakeAt = kind === 'hash' ? work.hashWakeAt : work.fetchWakeAt;
        if (wakeAt !== null) this.scheduleIoFlush(kind, Math.max(0, wakeAt - now));
        return;
      }
      if (kind === 'hash') void this.fetchHashBatch(keys);
      else void this.fetchBatch(keys);
    }
  }

  private scheduleIoFlush(kind: IoQueueKind, delayMs: number) {
    if (this.disposed) return;
    const dueAt = performance.now() + delayMs;
    if (this.ioTimer(kind) && this.ioWakeAt[kind] <= dueAt) return;
    const prior = this.ioTimer(kind);
    if (prior) clearTimeout(prior);
    this.ioWakeAt[kind] = dueAt;
    this.setIoTimer(
      kind,
      setTimeout(() => {
        this.setIoTimer(kind, null);
        this.ioWakeAt[kind] = Infinity;
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
    if (state === 'absent') this.resetIoRetry(e);
    if (clearSource) {
      e.contentDigest = null;
      e.resolution = undefined;
    }
    this.clearReadyFlags(e);
    this.invalidatePendingMeshes(e);
    if (state === 'absent') this.markNeighborsDirty(e);
    if (removeMesh) this.removeDisplayedMesh(e);
  }

  private resetIoRetry(e: ChunkEntry) {
    e.retryAt = 0;
    e.retryAttempts = 0;
    e.lastError = undefined;
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
    e.retryAt = performance.now() + chunkRetryDelayMs(e.retryAttempts);
    e.state = e.contentDigest ? 'hashed' : 'checking';
    if (e.state === 'checking') this.queueIo('hash', e.key);
    else this.queueIo('fetch', e.key);
    debugLog('chunk-runtime', 'io-retry', { key: e.key, attempt: e.retryAttempts, error: e.lastError });
  }

  private resetAfterSourceChange(e: ChunkEntry) {
    this.removeDisplayedMesh(e);
    this.broadcast({ type: 'drop', key: e.key });
    this.invalidatePendingMeshes(e);
    this.markNeighborsDirty(e);
    e.displayedVersion = -1;
    e.dirty = false;
    this.clearReadyFlags(e);
  }

  private releaseWorkerData(e: ChunkEntry): boolean {
    if (!workerDataReleasable(e, performance.now())) return false;
    this.broadcast({ type: 'drop', key: e.key });
    e.workerReadyMask = 0;
    e.state = 'hashed';
    return true;
  }

  private applyResidencyPlan(keepKeys: ReadonlySet<string>, now: number) {
    const plan = selectResidencyReleases({
      entries: [...this.chunks.values()].map((entry) => ({ ...entry, workerCopies: this.workerReadyCount(entry) })),
      keepKeys,
      workers: this.workers.length,
      now,
      budget: this.budget,
      demandFor: (key) => this.scheduler.demandFor(key),
      isSatisfied: (entry) => this.scheduler.entrySatisfied(entry),
    });
    for (const key of plan.workerKeys) this.releaseWorkerData(this.chunks.get(key)!);
    for (const key of plan.meshKeys) this.removeDisplayedMesh(this.chunks.get(key)!);
  }

  async refreshResources() {
    const seq = ++this.refreshSeq;
    const selected = new Map(
      [...this.chunks].map(([key, entry]) => [key, { entry, resolution: entry.resolution, request: entry.ioRequest }]),
    );
    const rows = await resolveChunks(
      this.opts.world,
      this.opts.dimension,
      [...selected.values()].map(({ entry }) => ({ cx: entry.cx, cz: entry.cz })),
      this.requests.signal,
    );
    if (this.disposed || seq !== this.refreshSeq) return;
    for (const row of rows) {
      const key = this.key(row.cx, row.cz);
      const snapshot = selected.get(key);
      if (!snapshot) continue;
      const { entry, resolution, request } = snapshot;
      if (this.chunks.get(key) !== entry || entry.resolution !== resolution || entry.ioRequest !== request) continue;
      if (row.missing) {
        entry.ioRequest = undefined;
        this.markUnavailable(entry, 'absent', true);
        continue;
      }
      entry.resolution = row;
      if (row.contentDigest !== entry.contentDigest) {
        // The new source revision supersedes the old body request as well as
        // its geometry. Its late reply must not regain ownership of this entry.
        entry.ioRequest = undefined;
        this.resetAfterSourceChange(entry);
        this.resetIoRetry(entry);
        entry.contentDigest = row.contentDigest ?? null;
        entry.state = 'hashed';
        this.queueIo('fetch', entry.key);
      }
    }
    await this.loadChunkSourceCoverage();
  }
  private handleFetchedResolution(payload: ResolvedChunk) {
    if (payload.head.renderRoot !== this.opts.renderRoot)
      throw new ResourceError('RESOURCE_VIEW_EXPIRED', 'chunk belongs to a different render root', true);
    const key = this.key(payload.cx, payload.cz);
    const e = this.chunks.get(key);
    if (!e || (e.state !== 'resolving' && e.state !== 'hashed' && e.state !== 'fetching')) return;
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
    if (e.state === 'resolving') this.resetIoRetry(e);
    if (e.state !== 'fetching') e.state = 'hashed';
  }

  private async fetchHashBatch(keys: string[]) {
    if (this.disposed) return;
    const entries = keys
      .map((key) => this.chunks.get(key))
      .filter((e): e is ChunkEntry => !!e && e.state === 'checking');
    if (!entries.length) return;
    const batch = new ChunkIoBatch(entries, 'resolving');
    this.checking++;
    const started = performance.now();
    const opId = this.metrics.begin('hashFetch', `${entries.length} hashes`);
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
        if (batch.current(this.key(payload.cx, payload.cz), this.chunks)) this.handleFetchedResolution(payload);
      }
      for (const e of entries) {
        if (!seen.has(e.key) && batch.current(e.key, this.chunks)) this.markUnavailable(e, 'absent', true);
      }
      debugLog('chunk-runtime', 'hash-batch', { requested: entries.length, returned: payloads.length, missing });
    } catch (error) {
      if (this.disposed) return;
      debugLog('chunk-runtime', 'hash-batch-error', {
        requested: entries.length,
        error: error instanceof Error ? error.message : String(error),
      });
      for (const e of entries) {
        if (batch.current(e.key, this.chunks)) this.retryIo(e, error);
      }
      this.reportStats();
    } finally {
      this.metrics.finish(opId, performance.now() - started);
      batch.release();
      this.checking--;
      this.flushIoQueue('hash');
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
    // IO may finish while a failed pool is backing off. No Worker can
    // acknowledge this payload yet; keep it eligible for a real dispatch.
    if (!this.workers.length) {
      e.state = 'hashed';
      this.queueIo('fetch', e.key);
      return;
    }
    e.state = 'decoding';
    e.decodingStartedAt = performance.now();
    this.resetIoRetry(e);
    e.workerReadyMask = 0;
    this.chunkBytesDecoded += payload.data.byteLength;
    this.activity.chunkDispatches++;
    this.activity.lastProgressAt = performance.now();
    const chunk = this.chunkBuffer(payload.data);
    const entities = payload.entities ? this.chunkBuffer(payload.entities) : undefined;
    if (payload.entities) this.chunkBytesDecoded += payload.entities.byteLength;
    try {
      this.sendChunkToWorkers(
        { type: 'chunk', key, contentDigest: contentHash, cx: e.cx, cz: e.cz, dimension: this.opts.dimensionDef },
        chunk,
        entities,
      );
    } catch (error) {
      this.recoverWorkers(error instanceof Error ? error.message : String(error));
      this.queueIo('fetch', e.key);
    }
  }

  private async fetchBatch(keys: string[]) {
    if (this.disposed) return;
    const entries = keys.map((key) => this.chunks.get(key)).filter((e): e is ChunkEntry => !!e && e.state === 'hashed');
    if (!entries.length) return;
    const batch = new ChunkIoBatch(entries, 'fetching');
    this.fetching++;
    const started = performance.now();
    const opId = this.metrics.begin('chunkFetch', `${entries.length} chunks`);
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
        for (const row of refreshed)
          if (batch.current(this.key(row.cx, row.cz), this.chunks)) this.handleFetchedResolution(row);
      }
      const payloads = await readChunks(
        entries.filter((e) => batch.current(e.key, this.chunks)).map((e) => e.resolution!),
        this.budget.chunkDownloadConcurrency,
        this.requests.signal,
      );
      if (this.disposed) return;
      let missing = 0;
      let bytes = 0;
      for (const outcome of payloads) {
        const key = this.key(outcome.cx, outcome.cz);
        if (!batch.current(key, this.chunks)) continue;
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
        if (!seen.has(e.key) && batch.current(e.key, this.chunks)) this.markUnavailable(e, 'absent', true);
      }
      debugLog('chunk-runtime', 'chunk-batch', {
        requested: entries.length,
        returned: payloads.length,
        missing,
        bytes,
      });
    } catch (error) {
      if (this.disposed) return;
      debugLog('chunk-runtime', 'chunk-batch-error', {
        requested: entries.length,
        error: error instanceof Error ? error.message : String(error),
      });
      for (const e of entries) {
        if (batch.current(e.key, this.chunks)) this.retryIo(e, error);
      }
      this.reportStats();
    } finally {
      this.metrics.finish(opId, performance.now() - started);
      batch.release();
      this.fetching--;
      this.flushIoQueue('fetch');
    }
  }

  // #endregion

  // #region Worker messages

  private matchWorkerMeshReply(key: string, version: number, kind: MeshTaskKind): MeshJob | undefined {
    const job = this.meshJobs.get(version);
    if (!job) return undefined;
    if (job.phase !== 'worker' || job.entry.key !== key || job.kind !== kind) {
      this.recoverWorkers('mesh worker returned a reply for a different task');
      return undefined;
    }
    return job;
  }

  private handleMessage(msg: WorkerResponse, workerIndex: number) {
    switch (msg.type) {
      case 'chunkReady': {
        this.metrics.record('parse', msg.profile?.parseMs, msg.key);
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
        this.terrain.updateSurface(e.key, e.surfaceY);
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
        if (!this.matchWorkerMeshReply(msg.key, msg.version, msg.kind)) return;
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
        if (!this.matchWorkerMeshReply(msg.key, msg.version, 'full')) return;
        this.finishActiveMesh(msg.version, msg.profile?.meshMs);
        const e = this.chunks.get(msg.key);
        if (!e || e.pendingFullVersion !== msg.version) return;
        const cacheParts = e.pendingFullCacheParts;
        const dirtyToken = e.pendingFullDirtyToken;
        this.clearPendingMesh(e, 'full');
        if (msg.profile?.missingInput) {
          this.recoverMissingWorkerInput(e);
          return;
        }
        if (e.state !== 'stored') {
          this.reportStats();
          return;
        }
        const shouldDisplay = this.scheduler.shouldAcceptMeshResult({
          entry: e,
          kind: 'full',
          step: 1,
          version: msg.version,
          now: performance.now(),
        });
        if (cacheParts)
          void putCachedMesh({ ...cacheParts, mode: 'full', step: 0 }, { mode: 'full', sections: msg.sections }).catch(
            () => {},
          );
        if (!shouldDisplay) {
          this.rescheduleStoredIfFresh(e);
          this.reportStats();
          return;
        }
        this.applyMesh(e, { mode: 'full', sections: msg.sections }, msg.version, 1);
        if (dirtyToken >= 0) this.clearDirtyIfUnchanged(e, dirtyToken);
        this.reportStats();
        break;
      }
      case 'lodResult': {
        const job = this.matchWorkerMeshReply(msg.key, msg.version, 'lod');
        if (!job) return;
        if (!LOD_STEPS.includes(msg.step as LodStep) || msg.step <= 1 || msg.step !== job.step) {
          this.recoverWorkers('mesh worker returned an invalid or mismatched LOD step');
          return;
        }
        this.finishActiveMesh(msg.version, msg.profile?.meshMs);
        const e = this.chunks.get(msg.key);
        const step = msg.step as LodStep;
        let cacheParts: MeshCacheBaseParts | null = null;
        let dirtyToken = -1;
        if (e && e.pendingLodStep === step && e.pendingLodVersion === msg.version) {
          cacheParts = e.pendingLodCacheParts;
          dirtyToken = e.pendingLodDirtyToken;
          this.clearPendingMesh(e, 'lod');
        }
        if (!e || dirtyToken < 0 || msg.version < e.displayedVersion) return;
        if (msg.profile?.missingInput) {
          this.recoverMissingWorkerInput(e);
          return;
        }
        if (e.state !== 'stored') {
          this.reportStats();
          return;
        }
        const shouldDisplay = this.scheduler.shouldAcceptMeshResult({
          entry: e,
          kind: 'lod',
          step: step,
          version: msg.version,
          now: performance.now(),
        });
        if (cacheParts)
          void putCachedMesh({ ...cacheParts, mode: 'lod', step }, { mode: 'lod', mesh: msg.mesh }).catch(() => {});
        if (!shouldDisplay) {
          this.rescheduleStoredIfFresh(e);
          this.reportStats();
          return;
        }
        this.applyMesh(e, { mode: 'lod', mesh: msg.mesh }, msg.version, step as LodStep);
        if (dirtyToken >= 0) this.clearDirtyIfUnchanged(e, dirtyToken);
        this.reportStats();
        break;
      }
    }
  }

  private applyMesh(e: ChunkEntry, mesh: TerrainMesh, version: number, step: LodStep) {
    this.activity.meshApplications++;
    this.activity.lastProgressAt = performance.now();
    Object.assign(e, this.terrain.replace(e, mesh, version, step));
    this.scheduler.notify({ type: 'meshDisplayed', entry: e, kind: mesh.mode, step, version, now: performance.now() });
    if (mesh.mode === 'lod' && this.scheduler.demandFor(e.key)?.targetStep === 1) this.flushMeshQueue();
    debugLog('chunk-runtime', 'display-mesh', { key: e.key, mode: mesh.mode, step, meshBytes: e.meshBytes });
    this.reportStats();
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
      if (e.displayed === 'lod' && this.terrain.hasVisibleMesh(e.key)) lodRendered++;
      if (e.fullReady) fullReady++;
      if (e.displayed === 'full' && this.terrain.hasVisibleMesh(e.key)) fullRendered++;
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
      displayedMeshBytes: this.terrain.meshBytes,
      chunkBytesDecoded: this.chunkBytesDecoded,
      ...this.metrics.snapshot(),
      fullCacheHits: this.fullCacheHits,
      fullCacheMisses: this.fullCacheMisses,
      lodCacheHits: this.lodCacheHits,
      lodCacheMisses: this.lodCacheMisses,
    };
  }

  private syncSchedulerStats(): ChunkSchedulerStats {
    const renderStats = this.collectRenderStats();
    this.schedulerStats = {
      ...renderStats,
      ...this.collectProfileStats(),
      ...this.scheduler.queueStats(this.chunks, performance.now()),
    };
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
    this.terrain.dispose();
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
    this.inFlightMeshVersions.clear();
    this.meshJobs.clear();
    this.versionWorker.clear();
    this.metrics.clear();
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.workerLoads = [];
  }

  // #endregion
}
