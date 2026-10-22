import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { SkyScene } from '../src/render/skyScene.js';

test('sky owns only supplied images, selects the first moon-sheet frame and disposes shared geometry once', () => {
  const scene = new THREE.Scene();
  const sky = new SkyScene(scene, {
    sun: { id: 'sun', image: { width: 16, height: 16 } as HTMLImageElement, layout: 'single' },
    moon: { id: 'phases', image: { width: 128, height: 64 } as HTMLImageElement, layout: 'moon-sheet' },
  });
  const geometry = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures: THREE.Texture[] = [];
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Points)) return;
    geometry.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      if (material instanceof THREE.MeshBasicMaterial && material.map) textures.push(material.map);
    }
  });
  assert.equal(geometry.size, 3);
  assert.equal(materials.size, 4);
  assert.deepEqual(sky.diagnosticSnapshot(), { sun: 'sun', moon: 'phases' });
  const moon = textures.find((texture) => texture.name === 'phases')!;
  assert.deepEqual(moon.repeat.toArray(), [0.25, 0.5]);
  assert.deepEqual(moon.offset.toArray(), [0, 0.5]);
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(30, 60, -90);
  sky.update(camera, 0, 1, true, new THREE.Color(0), new THREE.Color(0));
  assert.deepEqual(sky.group.position.toArray(), camera.position.toArray());
  let releases = 0;
  for (const resource of [...geometry, ...materials, ...textures])
    resource.addEventListener('dispose', () => releases++);
  sky.dispose();
  sky.dispose();
  assert.equal(releases, geometry.size + materials.size + textures.length);
  assert.equal(scene.children.length, 0);
});

test('explicitly absent sky images allocate no celestial textures or plane geometry', () => {
  const scene = new THREE.Scene();
  const sky = new SkyScene(scene, { sun: null, moon: null });
  assert.deepEqual(sky.diagnosticSnapshot(), { sun: null, moon: null });
  assert.equal(sky.group.children.length, 2);
  sky.dispose();
});
