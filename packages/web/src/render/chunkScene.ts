import { surfaceRepresentationAllowed } from '../view/representation';
import type { ViewState } from '../view/state';
import type { TopClipRange } from '../view/worldGeometry';
import type { RenderLayer } from '@violet-map/core/assets';
import { meshByteLength, SECTION_VISIBILITY_ALL, type MeshBuffers } from '@violet-map/render';
import * as THREE from 'three';
import { StaticMesh } from './staticMesh';
import type { LodStep } from '../view/terrain';
import { WORLD_MIN_Y, WORLD_MAX_Y } from '../view/worldGeometry';
import type { TerrainMesh, SectionMesh } from '../view/terrain';
import { EMPTY_CHUNK_DISPLAY, type TerrainChunk, type ChunkDisplayState } from '../view/terrain';
import type { ChunkDisplay } from '../runtime/chunkDisplay';
import type { TerrainMaterials } from './materials';

interface FullSectionRender {
  key: string;
  chunkKey: string;
  cx: number;
  sy: number;
  cz: number;
  visibility: number;
  meshes: THREE.Mesh[];
  specialMeshes: THREE.Mesh[];
  visible: boolean;
}

interface ChunkSceneEntry extends TerrainChunk, ChunkDisplayState {
  surfaceY: number;
  group: THREE.Object3D | null;
  fullSections: FullSectionRender[];
  meshBytes: number;
  fullReady: boolean;
  lodReadyStep: number;
}

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

export class ChunkScene implements ChunkDisplay {
  private readonly chunks = new Map<string, ChunkSceneEntry>();
  private readonly coordinateIndex = new Map<string, ChunkSceneEntry>();
  private fullSectionIndex = new Map<string, FullSectionRender>();
  private displayedMeshBytes = 0;
  private latestCamera: ViewState | null = null;
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
  private lastSpecialKeys: ReadonlySet<string> | null = null;
  readonly root = new THREE.Group();
  private topDownView = false;
  private topClipRange: TopClipRange = { minY: WORLD_MIN_Y, maxY: WORLD_MAX_Y };
  private fullDetailKeys: ReadonlySet<string> = new Set();
  constructor(
    private scene: THREE.Scene,
    private materials: TerrainMaterials,
  ) {
    this.root.matrixAutoUpdate = false;
    this.root.updateMatrix();
    scene.add(this.root);
  }
  get view() {
    return { topDownView: this.topDownView, topClipRange: this.topClipRange };
  }
  get meshBytes() {
    return this.displayedMeshBytes;
  }
  setView(camera: ViewState) {
    const topDownView = camera.mode === 'top';
    const topClipRange = camera.clip;
    this.latestCamera = camera;
    const changed = this.topDownView !== topDownView;
    if (changed || topClipRange.minY !== this.topClipRange.minY || topClipRange.maxY !== this.topClipRange.maxY) {
      this.topDownView = topDownView;
      this.topClipRange = topClipRange;
      this.applyTopClipVisibility();
      if (changed) this.lastVisibilityRevision = -1;
    }
  }
  updateVisibility(fullDetailKeys: ReadonlySet<string>) {
    this.fullDetailKeys = fullDetailKeys;
    if (this.latestCamera) {
      this.updateFullSectionVisibility(this.latestCamera);
      this.updateSpecialRenderVisibility();
    }
  }
  replace(chunk: TerrainChunk, mesh: TerrainMesh, version: number, step: LodStep): ChunkDisplayState {
    this.remove(chunk.key);
    const entry: ChunkSceneEntry = { ...chunk, ...EMPTY_CHUNK_DISPLAY, group: null, fullSections: [] };
    this.chunks.set(entry.key, entry);
    this.coordinateIndex.set(entry.cx + ',' + entry.cz, entry);
    if (mesh.mode === 'full') this.displayFull(entry, mesh.sections, version);
    else this.displayLod(entry, mesh.mesh, version, step);
    return {
      displayed: entry.displayed,
      displayedVersion: entry.displayedVersion,
      displayedLodStep: entry.displayedLodStep,
      fullReady: entry.fullReady,
      lodReadyStep: entry.lodReadyStep,
      meshBytes: entry.meshBytes,
    };
  }

  updateSurface(key: string, surfaceY: number) {
    const entry = this.chunks.get(key);
    if (entry) entry.surfaceY = surfaceY;
  }

  private entryAt(cx: number, cz: number) {
    return this.coordinateIndex.get(cx + ',' + cz);
  }

  dispose() {
    for (const key of this.chunks.keys()) this.remove(key);
    this.scene.remove(this.root);
    this.visibleSectionKeys.clear();
    this.visibilityEntryMasks.clear();
    this.visibilityQueueSections.length = 0;
    this.visibilityQueueEntries.length = 0;
  }
  private sectionKey(cx: number, sy: number, cz: number) {
    return `${cx},${sy},${cz}`;
  }

  displayedChunkKeys(): ReadonlySet<string> {
    if (!this.displayedChunkKeyCacheDirty) return this.displayedChunkKeyCache;
    const out = new Set<string>();
    for (const e of this.chunks.values()) {
      if (e.displayed === 'none' || !this.hasVisibleMesh(e.key)) continue;
      out.add(`${e.cx},${e.cz}`);
    }
    this.displayedChunkKeyCache = out;
    this.displayedChunkKeyCacheDirty = false;
    return out;
  }

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
    return surfaceRepresentationAllowed(this.topDownView ? 'top' : 'perspective', this.topClipRange);
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

  private updateFullSectionVisibility(camera: ViewState) {
    if (!this.fullSectionIndex.size) return;
    if (this.topDownView) return;
    const startCx = Math.floor(camera.position.x / 16);
    const startSy = Math.floor(camera.position.y / 16);
    const startCz = Math.floor(camera.position.z / 16);
    const startKey = this.sectionKey(startCx, startSy, startCz);
    const startEntry = this.entryAt(startCx, startCz);
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

  private updateSpecialRenderVisibility() {
    if (
      this.lastSpecialVisibilityRevision === this.sectionVisibilityRevision &&
      this.lastSpecialKeys === this.fullDetailKeys
    )
      return;
    let changed = false;
    for (const section of this.fullSectionIndex.values()) {
      const allowed = section.visible && this.fullDetailKeys.has(section.chunkKey);
      for (const mesh of section.specialMeshes) {
        if (mesh.visible === allowed) continue;
        mesh.visible = allowed;
        changed = true;
      }
    }
    this.lastSpecialVisibilityRevision = this.sectionVisibilityRevision;
    this.lastSpecialKeys = this.fullDetailKeys;
    if (changed) this.invalidateDisplayedChunkKeys();
  }

  private displayFull(e: ChunkSceneEntry, sections: SectionMesh[], version: number) {
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.updateMatrix();
    let meshBytes = 0;
    for (const s of sections) {
      const sectionMeshes: THREE.Mesh[] = [];
      const specialMeshes: THREE.Mesh[] = [];
      const sectionVisible = this.fullSectionWithinTopClip(s.sy);
      for (const [layer, buffers] of Object.entries(s.layers) as [RenderLayer, MeshBuffers][]) {
        if (!this.hasRenderableGeometry(buffers)) continue;
        const built = this.buildGeometry(buffers, true);
        meshBytes += built.bytes;
        const mesh = new StaticMesh(built.geometry, this.materials[layer]);
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
        chunkKey: e.key,
        cx: e.cx,
        sy: s.sy,
        cz: e.cz,
        visibility: s.visibility,
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
    if (this.latestCamera) this.updateSpecialRenderVisibility();
    e.displayed = 'full';
    e.displayedVersion = version;
    e.displayedLodStep = 0;
    e.fullReady = meshBytes > 0;
    this.invalidateDisplayedChunkKeys();
  }

  private displayLod(e: ChunkSceneEntry, meshBuffers: MeshBuffers | null, version: number, step: number) {
    if (meshBuffers && this.hasRenderableGeometry(meshBuffers)) {
      const built = this.buildGeometry(meshBuffers, false);
      e.meshBytes = built.bytes;
      this.displayedMeshBytes += e.meshBytes;
      const mesh = new StaticMesh(built.geometry, this.materials.lod);
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

  remove(key: string) {
    const e = this.chunks.get(key);
    if (!e) return;
    this.chunks.delete(key);
    this.coordinateIndex.delete(e.cx + ',' + e.cz);
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

  hasVisibleMesh(key: string): boolean {
    const e = this.chunks.get(key);
    if (!e || !e.group || !e.group.visible) return false;
    if (e.displayed === 'lod') {
      return e.group instanceof THREE.Mesh
        ? e.group.visible
        : e.group.children.some((child) => child instanceof THREE.Mesh && child.visible);
    }
    if (e.displayed !== 'full') return false;
    return e.fullSections.some((section) => section.meshes.some((mesh) => mesh.visible));
  }
}
