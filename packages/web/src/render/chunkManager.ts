import * as THREE from 'three';
import type { DimensionDef, MeshBuffers, RenderLayer } from '@violet-map/core';
import { fetchChunkHashes, fetchChunks, type ChunkHashPayload, type ChunkPayload } from '../api';
import { chunkKey, type SectionMeshMsg, WorkerInit, WorkerRequest, WorkerResponse } from '../worker/protocol';
import { getCachedFull, getCachedLod, putCachedFull, putCachedLod, type MeshCacheKeyParts } from '../meshCache';
import type { TerrainMaterials } from './materials';

type ChunkState = 'checking' | 'hashed' | 'fetching' | 'stored' | 'absent' | 'error';
const UPDATE_INTERVAL_MS = 100;
type MeshCacheBaseParts = Omit<MeshCacheKeyParts, 'mode' | 'step'>;

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
  private meshing = 0;
  private versionCounter = 0;
  private lastUpdate = 0;
  private lastCenterKey = '';
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
  update(cameraPos: THREE.Vector3, now: number, force = false) {
    const ccx = Math.floor(cameraPos.x / 16);
    const ccz = Math.floor(cameraPos.z / 16);
    const centerKey = `${ccx},${ccz}`;
    if (!force && centerKey === this.lastCenterKey && now - this.lastUpdate < UPDATE_INTERVAL_MS) return;
    this.lastUpdate = now;
    this.lastCenterKey = centerKey;
    const { viewDistance, lodDistance } = this.opts;
    const total = viewDistance + lodDistance;

    // 卸载
    for (const [key, e] of this.chunks) {
      const d = Math.max(Math.abs(e.cx - ccx), Math.abs(e.cz - ccz));
      if (d > total + 2) {
        this.removeMesh(e);
        if (e.state === 'stored') this.send({ type: 'drop', key });
        this.chunks.delete(key);
        this.hashQueue.delete(key);
        this.fetchQueue.delete(key);
      }
    }

    // 期望集合（按距离排序）
    const wanted: { cx: number; cz: number; d: number; dist2: number }[] = [];
    for (let dz = -total; dz <= total; dz++) {
      for (let dx = -total; dx <= total; dx++) {
        wanted.push({ cx: ccx + dx, cz: ccz + dz, d: Math.max(Math.abs(dx), Math.abs(dz)), dist2: dx * dx + dz * dz });
      }
    }
    wanted.sort((a, b) => a.d - b.d || a.dist2 - b.dist2);

    for (const w of wanted) {
      const key = this.key(w.cx, w.cz);
      let e = this.chunks.get(key);
      if (!e) {
        e = {
          cx: w.cx, cz: w.cz,
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
        };
        this.chunks.set(key, e);
        this.enqueueHash(key);
      }
      if (e.state === 'checking' || e.state === 'fetching' || e.state === 'absent' || e.state === 'error') continue;

      const wantFull = w.d <= this.opts.viewDistance;
      if (wantFull) {
        if (e.displayed !== 'full' && e.displayedLodStep !== 1 && !e.pendingLod && !e.pendingFull) {
          this.requestLod(key, e, 1);
        }
        const needs = e.displayed !== 'full' || e.dirty;
        if (needs && !e.pendingFull && this.meshing < 4) this.requestFull(key, e);
      } else {
        const step = this.lodStepForDistance(w.d);
        if ((e.displayed !== 'lod' || e.displayedLodStep !== step || e.dirty) && !(e.pendingLod && e.pendingLodStep === step)) {
          this.requestLod(key, e, step);
        }
      }
    }
    this.prioritizeQueues(wanted.map((w) => this.key(w.cx, w.cz)));
    this.flushHashQueue();
    this.flushFetchQueue();
    this.reportStats();
  }

  private lodStepForDistance(distance: number): number {
    const span = Math.max(1, this.opts.lodDistance);
    const t = Math.min(1, Math.max(0, (distance - this.opts.viewDistance) / span));
    if (t <= 0.25) return 1;
    if (t <= 0.5) return 2;
    if (t <= 0.75) return 4;
    return 8;
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
    const cache = this.neighborhoodCacheParts(e);
    if (!cache) {
      this.enqueueHash(key);
      return;
    }
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
      if (this.disposed) return;
      const current = this.chunks.get(key);
      if (!current || current.pendingFullVersion !== version) return;
      if (hit) {
        current.pendingFull = false;
        current.pendingFullCacheParts = null;
        if (version < current.displayedVersion) return;
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
    });
  }

  private startFullMeshing(key: string, current: ChunkEntry, version: number) {
    if (current.state !== 'stored') {
      current.pendingFull = false;
      current.pendingFullCacheParts = null;
      this.enqueueFetch(key);
      return;
    }
    if (this.meshing >= 4) {
      current.pendingFull = false;
      current.pendingFullCacheParts = null;
      return;
    }
    current.pendingFull = true;
    this.meshing++;
    this.send({ type: 'mesh', key, version });
  }

  private requestLod(key: string, e: ChunkEntry, step: number) {
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
    e.pendingLod = true;
    e.pendingLodStep = step;
    e.pendingLodCacheParts = cache.stable ? cache.parts : null;
    e.pendingLodDirtyToken = e.dirtyToken;
    e.pendingLodVersion = ++this.versionCounter;
    const version = e.pendingLodVersion;
    if (!cache.stable) {
      this.send({ type: 'lod', key, step, version });
      return;
    }
    void getCachedLod({ ...cache.parts, step }).then((hit) => {
      if (this.disposed) return;
      const current = this.chunks.get(key);
      if (!current || current.pendingLodVersion !== version || current.pendingLodStep !== step) return;
      if (hit !== undefined) {
        current.pendingLod = false;
        current.pendingLodStep = 0;
        current.pendingLodCacheParts = null;
        if (version < current.displayedVersion) return;
        this.displayLod(current, hit, version, step);
        this.clearDirtyIfUnchanged(current, current.pendingLodDirtyToken);
        return;
      }
      if (current.state !== 'stored') {
        current.pendingLod = false;
        current.pendingLodStep = 0;
        current.pendingLodCacheParts = null;
        this.enqueueFetch(key);
        return;
      }
      current.pendingLod = true;
      current.pendingLodStep = step;
      this.send({ type: 'lod', key, step, version });
    }).catch(() => {
      const current = this.chunks.get(key);
      if (current?.pendingLodVersion === version && current.pendingLodStep === step) {
        current.pendingLod = false;
        current.pendingLodStep = 0;
        current.pendingLodCacheParts = null;
        if (current.state !== 'stored') this.enqueueFetch(key);
      }
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
    const maxBatches = 4;
    const batchSize = 64;
    while (this.checking < maxBatches && this.hashQueue.size > 0) {
      const keys = [...this.hashQueue].slice(0, batchSize);
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
    const maxBatches = 4;
    const batchSize = 32;
    while (this.fetching < maxBatches && this.fetchQueue.size > 0) {
      const keys = [...this.fetchQueue].slice(0, batchSize);
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

  private prioritizeQueues(wantedKeys: string[]) {
    const order = new Map(wantedKeys.map((key, index) => [key, index]));
    const sortKeys = (keys: Iterable<string>) => [...keys].sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity));
    this.hashQueue = new Set(sortKeys(this.hashQueue));
    this.fetchQueue = new Set(sortKeys(this.fetchQueue));
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
        this.meshing = Math.max(0, this.meshing - 1);
        const e = this.chunks.get(msg.key);
        const cacheParts = e?.pendingFullVersion === msg.version ? e.pendingFullCacheParts : null;
        const dirtyToken = e?.pendingFullVersion === msg.version ? e.pendingFullDirtyToken : -1;
        if (e?.pendingFullVersion === msg.version) {
          e.pendingFull = false;
          e.pendingFullCacheParts = null;
        }
        if (!e || msg.version < e.displayedVersion) return;
        this.displayFull(e, msg.sections, msg.version);
        if (dirtyToken >= 0) this.clearDirtyIfUnchanged(e, dirtyToken);
        if (cacheParts) void putCachedFull(cacheParts, msg.sections).catch(() => {});
        this.reportStats();
        break;
      }
      case 'lodResult': {
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
        if (!e || msg.version < e.displayedVersion) return;
        this.displayLod(e, msg.mesh, msg.version, msg.step);
        if (dirtyToken >= 0) this.clearDirtyIfUnchanged(e, dirtyToken);
        if (cacheParts) void putCachedLod({ ...cacheParts, step: msg.step }, msg.mesh).catch(() => {});
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
      if (e.state === 'stored' || e.state === 'hashed') loaded++;
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
