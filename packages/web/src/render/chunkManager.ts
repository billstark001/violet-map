import * as THREE from 'three';
import type { DimensionDef, MeshBuffers, RenderLayer } from '@violet-map/core';
import { fetchChunkHashes, fetchChunks, type ChunkHashPayload, type ChunkPayload } from '../api';
import { chunkKey, type SectionMeshMsg, WorkerInit, WorkerRequest, WorkerResponse } from '../worker/protocol';
import { getCachedFull, getCachedLod, putCachedFull, putCachedLod, type MeshCacheKeyParts } from '../meshCache';
import type { TerrainMaterials } from './materials';
import {
  ChunkScheduler,
  LOD_STEPS,
  type ChunkSchedulerEntry,
  type ChunkState,
  type LodStep,
} from './chunkScheduler';

const UPDATE_INTERVAL_MS = 80;
const MAX_ACTIVE_MESH_TASKS = 4;
const MAX_MESH_WORKERS = 4;
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

interface FullSectionRender {
  key: string;
  cx: number;
  sy: number;
  cz: number;
  visibility: number;
  meshes: THREE.Mesh[];
}

interface ChunkEntry {
  cx: number; cz: number;
  state: ChunkState;
  workerReadyMask: number;
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
  lodReadyStep: number;
  fullReady: boolean;
  dirty: boolean;
  dirtyToken: number;
  group: THREE.Group | null;
  fullSections: FullSectionRender[];
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

export interface ChunkManagerStats {
  nbt: number;
  lodReady: number;
  lodRendered: number;
  fullReady: number;
  fullRendered: number;
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
  private activeMeshTasks = 0;
  private inFlightMeshVersions = new Set<number>();
  private versionCounter = 0;
  private lastUpdate = 0;
  private disposed = false;
  readonly root = new THREE.Group();
  onStats?: (s: ChunkManagerStats) => void;

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
    const hardware = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
    const workerCount = Math.max(1, Math.min(MAX_MESH_WORKERS, hardware > 2 ? hardware - 1 : 1));
    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(new URL('../worker/meshWorker.ts', import.meta.url), { type: 'module' });
      worker.postMessage({ type: 'init', ...initPayload } satisfies WorkerInit);
      worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.handleMessage(ev.data, i);
      this.workers.push(worker);
      this.workerLoads.push(0);
    }
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

  biomeAt(cx: number, cz: number): string | null {
    const e = this.chunks.get(this.key(cx, cz));
    return e?.state === 'stored' ? e.biome : null;
  }
  surfaceYAt(cx: number, cz: number): number | null {
    const e = this.chunks.get(this.key(cx, cz));
    return e?.state === 'stored' ? e.surfaceY : null;
  }

  private schedulerEntry(e: ChunkEntry, key = this.key(e.cx, e.cz)): ChunkSchedulerEntry {
    return {
      key,
      cx: e.cx,
      cz: e.cz,
      state: e.state,
      pendingFull: e.pendingFull,
      pendingLod: e.pendingLod,
      pendingLodStep: e.pendingLodStep,
      displayed: e.displayed,
      displayedLodStep: e.displayedLodStep,
      displayedVersion: e.displayedVersion,
      dirty: e.dirty,
      lastWantedAt: e.lastWantedAt,
      lastTier: e.lastTier,
      lastScore: e.lastScore,
      lastTargetStep: e.lastTargetStep,
      lastForcedFull: e.lastForcedFull,
    };
  }

  private schedulerEntryForKey(key: string): ChunkSchedulerEntry | null {
    const e = this.chunks.get(key);
    return e ? this.schedulerEntry(e, key) : null;
  }

  private schedulerEntries(): ChunkSchedulerEntry[] {
    return [...this.chunks.entries()].map(([key, e]) => this.schedulerEntry(e, key));
  }

  /** 每帧调用（内部节流）。 */
  update(camera: THREE.PerspectiveCamera, now: number, force = false, viewportHeight = window.innerHeight) {
    if (!force && now - this.lastUpdate < UPDATE_INTERVAL_MS) return;
    this.lastUpdate = now;

    this.scheduler.setOptions({ viewDistance: this.opts.viewDistance, lodDistance: this.opts.lodDistance });
    const frame = this.scheduler.planFrame(
      camera,
      now,
      force,
      viewportHeight,
      (cx, cz) => this.key(cx, cz),
      (key) => this.schedulerEntryForKey(key),
    );

    for (const candidate of frame.candidates) {
      const e = this.ensureEntry(candidate.cx, candidate.cz, now);
      e.lastWantedAt = now;
      e.lastTier = candidate.tier;
      e.lastScore = candidate.score;
      e.lastTargetStep = candidate.targetStep;
      e.lastForcedFull = candidate.forcedFull;
      const decision = this.scheduler.scheduleCandidate(candidate, this.schedulerEntry(e, candidate.key));
      if (decision.removeMesh) this.removeMesh(e);
    }

    this.scheduler.pruneQueues(frame.keepKeys, now);
    this.scheduler.expirePriorities(now);
    for (const key of this.scheduler.evictKeys(frame.centerCx, frame.centerCz, frame.keepKeys, this.schedulerEntries(), now)) {
      const e = this.chunks.get(key);
      if (e) this.dropEntry(key, e);
    }
    this.flushMeshQueue();
    this.flushHashQueue();
    this.flushFetchQueue();
    this.flushMeshQueue();
    this.updateFullSectionVisibility(camera);
    this.reportStats();
  }

  private ensureEntry(cx: number, cz: number, now: number): ChunkEntry {
    const key = this.key(cx, cz);
    let e = this.chunks.get(key);
    if (e) return e;
    e = {
      cx, cz,
      state: 'checking',
      workerReadyMask: 0,
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

  private rescheduleStoredIfFresh(key: string, e: ChunkEntry) {
    const now = performance.now();
    const entry = this.schedulerEntry(e, key);
    if (!this.scheduler.priorityFresh(entry, now)) return;
    this.scheduler.scheduleStoredFromLastPriority(key, entry, now);
    this.flushMeshQueue();
  }

  private flushMeshQueue() {
    while (this.activeMeshTasks < this.maxActiveMeshTasks()) {
      const task = this.scheduler.nextMeshTask((key) => this.schedulerEntryForKey(key), this.schedulerEntries(), performance.now());
      if (!task) return;
      const e = this.chunks.get(task.key);
      if (!e || e.state !== 'stored') continue;
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

  private dropEntry(key: string, e: ChunkEntry) {
    this.removeMesh(e);
    if (e.state === 'stored' || e.state === 'decoding') this.broadcast({ type: 'drop', key });
    this.chunks.delete(key);
    this.scheduler.deleteKey(key);
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
    if (this.activeMeshTasks >= this.maxActiveMeshTasks()) {
      const priority = this.scheduler.priorityFor(key, { tier: 3, score: 0, updatedAt: performance.now() });
      this.scheduler.enqueueMeshTask({ key, kind: 'full', step: 1, ...priority });
      return;
    }
    const cache = this.neighborhoodCacheParts(e);
    if (!cache) {
      this.queueHash(key);
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
        if (!this.scheduler.shouldApplyFullResult(this.schedulerEntry(current, key), version, performance.now())) {
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
        if (current.state !== 'stored') this.queueFetch(key);
      }
      this.finishActiveMesh();
    });
  }

  private startFullMeshing(key: string, current: ChunkEntry, version: number) {
    if (current.state !== 'stored') {
      current.pendingFull = false;
      current.pendingFullCacheParts = null;
      this.queueFetch(key);
      this.finishActiveMesh();
      return;
    }
    if (!this.scheduler.shouldApplyFullResult(this.schedulerEntry(current, key), version, performance.now())) {
      current.pendingFull = false;
      current.pendingFullCacheParts = null;
      this.finishActiveMesh();
      this.rescheduleStoredIfFresh(key, current);
      return;
    }
    current.pendingFull = true;
    const workerIndex = this.markWorkerMesh(version);
    this.sendToWorker(workerIndex, { type: 'mesh', key, version });
  }

  private requestLod(key: string, e: ChunkEntry, step: LodStep) {
    if (this.activeMeshTasks >= this.maxActiveMeshTasks()) {
      const priority = this.scheduler.priorityFor(key, { tier: 4, score: 0, updatedAt: performance.now() });
      this.scheduler.enqueueMeshTask({ key, kind: 'lod', step, ...priority });
      return;
    }
    if (!e.sourceHash) {
      this.queueHash(key);
      return;
    }
    if (e.state !== 'stored') {
      this.queueFetch(key);
      return;
    }
    const cache = this.neighborhoodCacheParts(e);
    if (!cache) {
      this.queueHash(key);
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
      if (!this.scheduler.shouldApplyLodResult(this.schedulerEntry(e, key), step, version, performance.now())) {
        e.pendingLod = false;
        e.pendingLodStep = 0;
        e.pendingLodCacheParts = null;
        this.finishActiveMesh();
        this.rescheduleStoredIfFresh(key, e);
        return;
      }
      const workerIndex = this.markWorkerMesh(version);
      this.sendToWorker(workerIndex, { type: 'lod', key, step, version });
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
        if (!this.scheduler.shouldApplyLodResult(this.schedulerEntry(current, key), step, version, performance.now())) {
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
        this.queueFetch(key);
        this.finishActiveMesh();
        return;
      }
      current.pendingLod = true;
      current.pendingLodStep = step;
      if (!this.scheduler.shouldApplyLodResult(this.schedulerEntry(current, key), step, version, performance.now())) {
        current.pendingLod = false;
        current.pendingLodStep = 0;
        current.pendingLodCacheParts = null;
        this.finishActiveMesh();
        this.rescheduleStoredIfFresh(key, current);
        return;
      }
      const workerIndex = this.markWorkerMesh(version);
      this.sendToWorker(workerIndex, { type: 'lod', key, step, version });
    }).catch(() => {
      const current = this.chunks.get(key);
      if (current?.pendingLodVersion === version && current.pendingLodStep === step) {
        current.pendingLod = false;
        current.pendingLodStep = 0;
        current.pendingLodCacheParts = null;
        if (current.state !== 'stored') this.queueFetch(key);
      }
      this.finishActiveMesh();
    });
  }

  private queueHash(key: string) {
    this.scheduler.enqueueHash(key);
    if (this.hashTimer) return;
    this.hashTimer = setTimeout(() => {
      this.hashTimer = null;
      this.flushHashQueue();
    }, 20);
  }

  private flushHashQueue() {
    while (true) {
      const keys = this.scheduler.nextHashBatch(this.checking, this.schedulerEntries(), this.activeMeshTasks);
      if (!keys.length) break;
      void this.fetchHashBatch(keys);
    }
    if (this.scheduler.hasHashWork && !this.hashTimer) {
      this.hashTimer = setTimeout(() => {
        this.hashTimer = null;
        this.flushHashQueue();
      }, 50);
    }
  }

  private queueFetch(key: string) {
    const e = this.chunks.get(key);
    if (e && e.state !== 'stored') e.state = 'fetching';
    this.scheduler.enqueueFetch(key);
    if (this.fetchTimer) return;
    this.fetchTimer = setTimeout(() => {
      this.fetchTimer = null;
      this.flushFetchQueue();
    }, 20);
  }

  private flushFetchQueue() {
    while (true) {
      const keys = this.scheduler.nextFetchBatch(this.fetching, this.schedulerEntries(), this.activeMeshTasks);
      if (!keys.length) break;
      void this.fetchBatch(keys);
    }
    if (this.scheduler.hasFetchWork && !this.fetchTimer) {
      this.fetchTimer = setTimeout(() => {
        this.fetchTimer = null;
        this.flushFetchQueue();
      }, 50);
    }
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
      e.lodReadyStep = 0;
      e.fullReady = false;
      this.removeMesh(e);
      return;
    }
    if (e.sourceHash && e.sourceHash !== payload.hash) {
      this.removeMesh(e);
      this.broadcast({ type: 'drop', key });
      e.displayedVersion = -1;
      e.dirty = false;
      e.lodReadyStep = 0;
      e.fullReady = false;
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
      e.lodReadyStep = 0;
      e.fullReady = false;
      this.removeMesh(e);
      return;
    }
    const sourceHash = payload.hash ?? payload.fileHash ?? null;
    if (!sourceHash) {
      e.state = 'error';
      e.lodReadyStep = 0;
      e.fullReady = false;
      return;
    }
    if (e.sourceHash && e.sourceHash !== sourceHash) {
      this.removeMesh(e);
      this.broadcast({ type: 'drop', key });
      e.displayedVersion = -1;
      e.dirty = false;
      e.lodReadyStep = 0;
      e.fullReady = false;
    }
    e.sourceHash = sourceHash;
    e.nbtHash = payload.nbtHash ?? null;
    e.source = payload.source ?? e.source;
    e.state = 'decoding';
    e.workerReadyMask = 0;
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

  private handleMessage(msg: WorkerResponse, workerIndex: number) {
    switch (msg.type) {
      case 'chunkReady': {
        const e = this.chunks.get(msg.key);
        if (!e) { this.broadcast({ type: 'drop', key: msg.key }); return; }
        if (e.state !== 'decoding' && e.state !== 'stored') break;
        e.workerReadyMask |= 1 << workerIndex;
        e.biome = msg.biome;
        e.surfaceY = msg.surfaceY;
        if (e.workerReadyMask !== this.allWorkersMask()) break;
        e.state = 'stored';
        // 邻居若已渲染需要重网格化（边界剔除/AO 才正确）
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dz) continue;
            const n = this.chunks.get(this.key(e.cx + dx, e.cz + dz));
            if (n && (n.displayed !== 'none' || n.pendingFull || n.pendingLod)) this.markDirty(n);
          }
        }
        this.scheduler.scheduleStoredFromLastPriority(msg.key, this.schedulerEntry(e, msg.key), performance.now());
        this.flushMeshQueue();
        this.reportStats();
        break;
      }
      case 'chunkError': {
        const e = this.chunks.get(msg.key);
        if (e) {
          e.state = 'error';
          e.lodReadyStep = 0;
          e.fullReady = false;
          this.removeMesh(e);
        }
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
        const shouldDisplay = this.scheduler.shouldApplyFullResult(this.schedulerEntry(e, msg.key), msg.version, performance.now());
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
        const shouldDisplay = this.scheduler.shouldApplyLodResult(this.schedulerEntry(e, msg.key), step, msg.version, performance.now());
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

  private visibilityAllows(mask: number, from: number, to: number): boolean {
    return Math.floor(mask / (2 ** (from * 6 + to))) % 2 >= 1;
  }

  private setAllFullSectionsVisible(visible: boolean) {
    for (const section of this.fullSectionIndex.values()) {
      for (const mesh of section.meshes) mesh.visible = visible;
    }
  }

  private updateFullSectionVisibility(camera: THREE.PerspectiveCamera) {
    if (!this.fullSectionIndex.size) return;
    const startCx = Math.floor(camera.position.x / 16);
    const startSy = Math.floor(camera.position.y / 16);
    const startCz = Math.floor(camera.position.z / 16);
    const start = this.fullSectionIndex.get(this.sectionKey(startCx, startSy, startCz));
    if (!start || start.visibility <= 0) {
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
        if (!next || visible.has(next.key)) continue;
        visible.add(next.key);
        queue.push({ section: next, entry: SECTION_OPPOSITE[dir] });
      }
    }

    for (const section of this.fullSectionIndex.values()) {
      const show = visible.has(section.key);
      for (const mesh of section.meshes) mesh.visible = show;
    }
  }

  private displayFull(e: ChunkEntry, sections: SectionMeshMsg[], version: number) {
    this.removeMesh(e);
    const group = new THREE.Group();
    for (const s of sections) {
      const sectionMeshes: THREE.Mesh[] = [];
      for (const [layer, buffers] of Object.entries(s.layers) as [RenderLayer, MeshBuffers][]) {
        const mesh = new THREE.Mesh(this.buildGeometry(buffers, true), this.materials[layer]);
        mesh.position.set(e.cx * 16, s.sy * 16, e.cz * 16);
        mesh.frustumCulled = true;
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
    if (group.children.length > 0) {
      this.root.add(group);
      e.group = group;
    }
    e.displayed = 'full';
    e.displayedVersion = version;
    e.displayedLodStep = 0;
    e.fullReady = true;
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
    e.lodReadyStep = step;
    if (e.lastTargetStep === 1) {
      const key = this.key(e.cx, e.cz);
      this.scheduler.scheduleStoredFromLastPriority(key, this.schedulerEntry(e, key), performance.now());
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
    for (const section of e.fullSections) this.fullSectionIndex.delete(section.key);
    e.fullSections = [];
    if (e.group) {
      this.root.remove(e.group);
      e.group.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    }
    e.group = null;
    e.displayed = 'none';
    e.displayedLodStep = 0;
    e.lodReadyStep = 0;
    e.fullReady = false;
  }

  private reportStats() {
    let nbt = 0, lodReady = 0, lodRendered = 0, fullReady = 0, fullRendered = 0;
    for (const e of this.chunks.values()) {
      if (e.state === 'decoding' || e.state === 'stored') nbt++;
      if (e.lodReadyStep > 0) lodReady++;
      if (e.displayed === 'lod' && e.group) lodRendered++;
      if (e.fullReady) fullReady++;
      if (e.displayed === 'full' && e.group) fullRendered++;
    }
    this.onStats?.({ nbt, lodReady, lodRendered, fullReady, fullRendered });
  }

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
    this.scene.remove(this.root);
    this.inFlightMeshVersions.clear();
    this.versionWorker.clear();
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.workerLoads = [];
  }
}
