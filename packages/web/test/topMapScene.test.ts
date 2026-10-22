import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import type { PreparedTopMapTile, TopMapTilePayload } from '@violet-map/core/formats/top-map';
import { TopMapScene } from '../src/render/topMapScene.js';
import { createSharedUniforms } from '../src/render/materials.js';

test('Top Map GPU ownership replaces only geometry and releases every owned resource exactly once', () => {
  const scene = new THREE.Scene();
  const display = new TopMapScene(scene, createSharedUniforms());
  const size = 4;
  const data: PreparedTopMapTile = {
    payload: {
      size: { blocks: size, samples: size, colorSamples: size, lightSamples: size },
      origin: { x: 0, z: 0 },
      sampleStride: 1,
      colorStride: 1,
      lightStride: 1,
      minY: 0,
      approach: 'top',
    } as TopMapTilePayload,
    heights: new Int16Array(size * size).fill(10),
    colors: new Uint8Array(size * size * 4),
    lights: new Uint8Array(size * size * 2).fill(15),
  };
  display.add('0,0', data);
  assert.throws(() => display.add('0,0', data), /already has GPU resources/);
  display.update('0,0', 2, '', undefined);
  const group = scene.children[0] as THREE.Group;
  const mesh = group.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  const texture = Object.values(mesh.material.uniforms)
    .map((uniform) => uniform.value)
    .find((value) => value instanceof THREE.DataTexture);
  assert.ok(texture);
  let geometryDisposals = 0,
    materialDisposals = 0,
    textureDisposals = 0;
  mesh.geometry.addEventListener('dispose', () => geometryDisposals++);
  mesh.material.addEventListener('dispose', () => materialDisposals++);
  texture.addEventListener('dispose', () => textureDisposals++);
  display.update('0,0', 4, '', undefined);
  assert.equal(geometryDisposals, 1);
  assert.equal(materialDisposals, 0);
  assert.equal(textureDisposals, 0);
  mesh.geometry.addEventListener('dispose', () => geometryDisposals++);
  display.setWanted(new Set());
  assert.equal(display.snapshot('0,0').visible, false);
  display.setWanted(new Set(['0,0']));
  assert.equal(display.snapshot('0,0').visible, true);
  display.remove('0,0');
  display.dispose();
  assert.deepEqual([geometryDisposals, materialDisposals, textureDisposals], [2, 1, 1]);
  assert.equal(scene.children.length, 0);
});
