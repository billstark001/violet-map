import { captureView } from '../src/render/viewSnapshot.js';
import * as THREE from 'three';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChunkScene } from '../src/render/chunkScene.js';
import { SECTION_VISIBILITY_ALL } from '@violet-map/render';
import { chunkKey } from '../src/worker/protocol.js';

test('section visibility revisits independent entrances and stops at a solid neighbor', () => {
  const mask = (pairs: number[][]) =>
    pairs.reduce((value, [from, to]) => value + 2 ** (from * 6 + to) + 2 ** (to * 6 + from), 0);
  const all = mask(
    Array.from({ length: 6 }, (_, from) =>
      Array.from({ length: 5 - from }, (_, offset) => [from, from + offset + 1]),
    ).flat(),
  );
  const sections = [
    [0, 0, mask([[2, 3]])],
    [1, 0, all],
    [
      2,
      0,
      mask([
        [4, 5],
        [2, 3],
      ]),
    ],
    [0, -1, all],
    [1, -1, all],
    [2, -1, all],
    [2, 1, all],
    [3, 0, 0],
    [4, 0, all],
  ].map(([cx, cz, visibility]) => ({
    key: `${cx},0,${cz}`,
    cx,
    sy: 0,
    cz,
    visibility,
    visible: true,
    meshes: [{ visible: true }],
  }));
  const manager = Object.assign(Object.create(ChunkScene.prototype), {
    entryAt: () => ({ surfaceY: 100 }),
    fullSectionIndex: new Map(sections.map((section) => [section.key, section])),
    chunks: new Map([[chunkKey('test', 'minecraft:overworld', 0, 0), { surfaceY: 100 }]]),
    topDownView: false,
    visibilityRevision: 1,
    lastVisibilityRevision: -1,
    visibleSectionKeys: new Set(),
    visibilityEntryMasks: new Map(),
    visibilityQueueSections: [],
    visibilityQueueEntries: [],
    sectionVisibilityRevision: 0,
  });
  manager.updateFullSectionVisibility({ position: { x: 1, y: 1, z: 1 } });
  assert.equal(
    manager.fullSectionIndex.get('2,0,1').visible,
    true,
    'the north entrance must reveal the south corridor even after a west entry',
  );
  assert.equal(
    manager.fullSectionIndex.get('3,0,0').visible,
    true,
    'the visible face of a solid boundary still renders',
  );
  assert.equal(
    manager.fullSectionIndex.get('4,0,0').visible,
    false,
    'zero connectivity must stop traversal behind the boundary',
  );
});

test('the scene owns mesh replacement, clip visibility and geometry disposal but shares materials', () => {
  const entry = {
    key: 'chunk',
    cx: 0,
    cz: 0,
    surfaceY: 64,
    displayed: 'none' as 'none' | 'full' | 'lod',
    displayedVersion: -1,
    displayedLodStep: 0,
    group: null as THREE.Object3D | null,
    fullSections: [],
    meshBytes: 0,
  };
  const scene = new THREE.Scene();
  const material = new THREE.MeshBasicMaterial();
  let materialDisposals = 0,
    geometryDisposals = 0;
  material.addEventListener('dispose', () => materialDisposals++);
  const terrain = new ChunkScene(scene, { opaque: material, specialCutout: material, lod: material } as never);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 80, 0);
  terrain.setView(captureView(camera, false, { minY: -80, maxY: 384 }));
  const mesh = {
    positions: new Uint16Array([0, 0, 0, 65535, 0, 0, 0, 65535, 0]),
    indices: new Uint16Array([0, 1, 2]),
    colors: new Uint8Array(12),
    lights: new Uint8Array(6),
  };
  terrain.replace(
    entry,
    {
      mode: 'full',
      sections: [{ sy: 0, layers: { opaque: mesh, specialCutout: mesh }, visibility: SECTION_VISIBILITY_ALL }],
    },
    1,
    1,
  );
  terrain.updateVisibility(new Set([entry.key]));
  assert.equal(terrain.displayedChunkKeys().has('0,0'), true);
  terrain.root.traverse((object) => {
    if (object instanceof THREE.Mesh) object.geometry.addEventListener('dispose', () => geometryDisposals++);
  });
  terrain.setView(captureView(camera, true, { minY: 32, maxY: 64 }));
  assert.equal(terrain.displayedChunkKeys().size, 0);
  terrain.setView(captureView(camera, false, { minY: -80, maxY: 384 }));
  terrain.updateVisibility(new Set([entry.key]));
  assert.equal(terrain.displayedChunkKeys().size, 1);
  terrain.replace(entry, { mode: 'lod', mesh }, 2, 2);
  assert.equal(geometryDisposals, 2);
  terrain.root.traverse((object) => {
    if (object instanceof THREE.Mesh) object.geometry.addEventListener('dispose', () => geometryDisposals++);
  });
  terrain.dispose();
  terrain.dispose();
  assert.equal(geometryDisposals, 3);
  assert.equal(materialDisposals, 0);
  assert.equal(scene.children.length, 0);
  assert.equal(terrain.meshBytes, 0);
  material.dispose();
});
