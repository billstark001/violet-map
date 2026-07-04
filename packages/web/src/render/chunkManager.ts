import * as THREE from 'three';
import type { DimensionDef, MeshBuffers, RenderLayer } from '@mcr/core';
import { fetchChunk } from '../api';
import { chunkKey, WorkerInit, WorkerRequest, WorkerResponse } from '../worker/protocol';
import type { TerrainMaterials } from './materials';

type ChunkState = 'fetching' | 'stored' | 'absent' | 'error';

interface ChunkEntry {
  cx: number; cz: number;
  state: ChunkState;
  meshVersion: number;       // 已请求的版本
  displayed: 'none' | 'full' | 'lod';
  displayedVersion: number;
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
        e = { cx: w.cx, cz: w.cz, state: 'fetching', meshVersion: -1, displayed: 'none', displayedVersion: -1, dirty: false, group: null, biome: 'minecraft:plains', surfaceY: 64 };
        this.chunks.set(key, e);
        this.startFetch(key, e);
      }
      if (e.state !== 'stored') continue;

      const wantFull = w.d <= this.opts.viewDistance;
      if (wantFull) {
        const ready = this.neighborsReady(w.cx, w.cz);
        const needs = e.displayed !== 'full' || e.dirty;
        if (ready && needs && this.meshing < 4) {
          e.dirty = false;
          e.meshVersion = ++this.versionCounter;
          this.meshing++;
          this.send({ type: 'mesh', key, version: e.meshVersion });
        }
      } else if (e.displayed !== 'lod') {
        e.meshVersion = ++this.versionCounter;
        this.send({ type: 'lod', key, step: w.d > this.opts.viewDistance + this.opts.lodDistance / 2 ? 4 : 2, version: e.meshVersion });
      }
    }
    this.reportStats();
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

  private async startFetch(key: string, e: ChunkEntry) {
    while (this.fetching >= 8) await new Promise((r) => setTimeout(r, 50));
    if (this.chunks.get(key) !== e) return;
    this.fetching++;
    try {
      const nbt = await fetchChunk(this.opts.world, this.opts.dimension, e.cx, e.cz);
      if (this.chunks.get(key) !== e) return;
      if (!nbt) { e.state = 'absent'; return; }
      this.send({ type: 'chunk', key, cx: e.cx, cz: e.cz, dimension: this.opts.dimensionDef, nbt }, [nbt]);
    } catch {
      e.state = 'error';
    } finally {
      this.fetching--;
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
        this.reportStats();
        break;
      }
      case 'lodResult': {
        const e = this.chunks.get(msg.key);
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
  }

  private reportStats() {
    let rendered = 0;
    for (const e of this.chunks.values()) if (e.displayed !== 'none') rendered++;
    this.onStats?.({ loaded: this.chunks.size, rendered });
  }

  dispose() {
    for (const e of this.chunks.values()) this.removeMesh(e);
    this.chunks.clear();
    this.scene.remove(this.root);
    this.worker.terminate();
  }
}