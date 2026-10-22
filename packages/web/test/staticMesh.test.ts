import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { StaticMesh } from '../src/render/staticMesh.js';

test('static world bounds reuse is derived from actual matrices and geometry, never stale flags', (t) => {
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.MeshBasicMaterial();
  const mesh = new StaticMesh(geometry, material);
  t.after(() => {
    for (const resource of new Set([geometry, mesh.geometry, material])) resource.dispose();
  });
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
  camera.position.z = 10;
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  let transforms = 0;
  const transform = THREE.Sphere.prototype.applyMatrix4;
  t.mock.method(THREE.Sphere.prototype, 'applyMatrix4', function (matrix) {
    transforms++;
    return transform.call(this, matrix);
  });
  for (let i = 0; i < 10; i++) assert.equal(mesh.intersectsFrustum(frustum), true);
  assert.equal(transforms, 1);
  mesh.matrixWorld.makeTranslation(100, 0, 0);
  assert.equal(mesh.intersectsFrustum(frustum), false);
  assert.equal(transforms, 2);
  geometry.translate(-100, 0, 0);
  const before = transforms;
  assert.equal(mesh.intersectsFrustum(frustum), true);
  assert.equal(transforms, before + 1);
  assert.equal(mesh.intersectsFrustum(frustum), true);
  assert.equal(transforms, before + 1);
  mesh.geometry = new THREE.PlaneGeometry(1, 1);
  assert.equal(mesh.intersectsFrustum(frustum), false);
});
