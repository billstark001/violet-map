import * as THREE from 'three';
import type { DimensionDef, MeshBuffers, RenderLayer } from '@violet-map/core';
import { fetchChunks, type ChunkPayload } from '../api';
import { chunkKey, WorkerInit, WorkerRequest, WorkerResponse } from '../worker/protocol';
import type { TerrainMaterials } from './materials';

type ChunkState = 'fetching' | 'stored' | 'absent' | 'error';

interface ChunkEntry {
  cx: number; cz: number;
  state: ChunkState;
  meshVersion: number;       // 已请求的版本
  pendingFull: boolean;
  pendingLod: boolean;
  pendingLodStep: number;
  displayed: 'none' | 'full' | 'lod';
  displayedVersion: number;
  displayedLodStep: number;
  dirty: boolean;
  group: THREE.Group | null;
  biome: string;
  surfaceY: number;
}

export interface ChunkManagerOptions {
  world: string;
  dimension: string;
  dimensionDef: DimensionDef;
  viewDistance: number;
  lodDistance: number;
}

export class ChunkManager {
  private worker: Worker;
  private chunks = new Map<string, ChunkEntry>();
  private fetching = 0;
  private fetchQueue = new Set<string>();
  private fetchTimer: ReturnType<typeof setTimeout> | null = null;
  private meshing = 0;
  private versionCounter = 0;
  private lastUpdate = 0;
  readonly root = new THREE.Group();
  onStats?: (s: { loaded: number; rendered: number }) => void;

  constructor(
    private scene: THREE.Scene,
    private materials: TerrainMaterials,
    private initPayload: Omit<WorkerInit, 'type'>,
    public opts: ChunkManagerOptions,
  ) {
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
  update(cameraPos: THREE.Vector3, now: number) {
    if (now - this.lastUpdate < 250) return;
    this.lastUpdate = now;
    const ccx = Math.floor(cameraPos.x / 16);
    const ccz = Math.floor(cameraPos.z / 16);
    const { viewDistance, lodDistance } = this.opts;
    const total = viewDistance + lodDistance;

    // 卸载
    for (const [key, e] of this.chunks) {
      const d = Math.max(Math.abs(e.cx - ccx), Math.abs(e.cz - ccz));
      if (d > total + 2) {
        this.removeMesh(e);
        if (e.state === 'stored') this.send({ type: 'drop', key });
        this.chunks.delete(key);
      }
    }

    // 期望集合（按距离排序）
    const wanted: { cx: number; cz: number; d: number }[] = [];
    for (let dz = -total; dz <= total; dz++) {
      for (let dx = -total; dx <= total; dx++) {
        wanted.push({ cx: ccx + dx, cz: ccz + dz, d: Math.max(Math.abs(dx), Math.abs(dz)) });
      }
    }
    wanted.sort((a, b) => a.d - b.d);

    for (const w of wanted) {
      const key = this.key(w.cx, w.cz);
      let e = this.chunks.get(key);
      if (!e) {
        e = {
          cx: w.cx, cz: w.cz,
          state: 'fetching',
          meshVersion: -1,
          pendingFull: false,
          pendingLod: false,
          pendingLodStep: 0,
          displayed: 'none',
          displayedVersion: -1,
          displayedLodStep: 0,
          dirty: false,
          group: null,
          biome: 'minecraft:plains',
          surfaceY: 64,
        };
        this.chunks.set(key, e);
        this.enqueueFetch(key);
      }
      if (e.state !== 'stored') continue;

      const wantFull = w.d <= this.opts.viewDistance;
      if (wantFull) {
        if (e.displayed !== 'full' && e.displayedLodStep !== 1 && !e.pendingLod && !e.pendingFull) {
          this.requestLod(key, e, 1);
        }
        const ready = this.neighborsReady(w.cx, w.cz);
        const needs = e.displayed !== 'full' || e.dirty;
        if (ready && needs && !e.pendingFull && this.meshing < 4) {
          e.dirty = false;
          e.pendingFull = true;
          e.meshVersion = ++this.versionCounter;
          this.meshing++;
          this.send({ type: 'mesh', key, version: e.meshVersion });
        }
      } else {
        const step = this.lodStepForDistance(w.d);
        if ((e.displayed !== 'lod' || e.displayedLodStep !== step) && !(e.pendingLod && e.pendingLodStep === step)) {
          this.requestLod(key, e, step);
        }
      }
    }
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

  private requestLod(key: string, e: ChunkEntry, step: number) {
    e.pendingLod = true;
    e.pendingLodStep = step;
    e.meshVersion = ++this.versionCounter;
    this.send({ type: 'lod', key, step, version: e.meshVersion });
  }

  private neighborsReady(cx: number, cz: number): boolean {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const e = this.chunks.get(this.key(cx + dx, cz + dz));
        if (!e || e.state === 'fetching') return false;
      }
    }
    return true;
  }

  private enqueueFetch(key: string) {
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

  private chunkBuffer(data: Uint8Array): ArrayBuffer {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }

  private handleFetchedChunk(payload: ChunkPayload) {
    const key = this.key(payload.cx, payload.cz);
    const e = this.chunks.get(key);
    if (!e || e.state !== 'fetching') return;
    if (!payload.data || payload.missing) {
      e.state = 'absent';
      return;
    }
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
            if (n?.displayed === 'full') n.dirty = true;
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
        if (e) e.pendingFull = false;
        if (!e || msg.version < e.displayedVersion) return;
        this.removeMesh(e);
        const group = new THREE.Group();
        for (const s of msg.sections) {
          for (const [layer, buffers] of Object.entries(s.layers) as [RenderLayer, MeshBuffers][]) {
            const mesh = new THREE.Mesh(this.buildGeometry(buffers, true), this.materials[layer]);
            mesh.position.set(e.cx * 16, s.sy * 16, e.cz * 16);
            group.add(mesh);
          }
        }
        this.root.add(group);
        e.group = group;
        e.displayed = 'full';
        e.displayedVersion = msg.version;
        e.displayedLodStep = 0;
        this.reportStats();
        break;
      }
      case 'lodResult': {
        const e = this.chunks.get(msg.key);
        if (e && e.pendingLodStep === msg.step) {
          e.pendingLod = false;
          e.pendingLodStep = 0;
        }
        if (!e || msg.version < e.displayedVersion) return;
        this.removeMesh(e);
        if (msg.mesh) {
          const mesh = new THREE.Mesh(this.buildGeometry(msg.mesh, false), this.materials.lod);
          mesh.position.set(e.cx * 16, 0, e.cz * 16);
          const group = new THREE.Group();
          group.add(mesh);
          this.root.add(group);
          e.group = group;
        }
        e.displayed = 'lod';
        e.displayedVersion = msg.version;
        e.displayedLodStep = msg.step;
        this.reportStats();
        break;
      }
    }
  }

  private buildGeometry(b: MeshBuffers, sectionBounds: boolean): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(b.positions, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(b.uvs, 2));
    g.setAttribute('tintColor', new THREE.BufferAttribute(b.colors, 3));
    g.setAttribute('lightData', new THREE.BufferAttribute(b.lights, 2));
    g.setIndex(new THREE.BufferAttribute(b.indices, 1));
    if (sectionBounds) g.boundingSphere = new THREE.Sphere(new THREE.Vector3(8, 8, 8), 16);
    else g.computeBoundingSphere();
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
    for (const e of this.chunks.values()) this.removeMesh(e);
    this.chunks.clear();
    this.fetchQueue.clear();
    if (this.fetchTimer) {
      clearTimeout(this.fetchTimer);
      this.fetchTimer = null;
    }
    this.scene.remove(this.root);
    this.worker.terminate();
  }
}
