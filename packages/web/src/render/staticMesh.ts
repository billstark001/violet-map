import * as THREE from 'three';

/** A mesh whose geometry and world bounds stay fixed throughout one frame's
 * render passes. Changes between frames still use Three's normal matrix updates.
 * Render callbacks may update uniforms, but must not change these bounds.
 */
export class StaticMesh<
  Geometry extends THREE.BufferGeometry = THREE.BufferGeometry,
  Material extends THREE.Material | THREE.Material[] = THREE.Material | THREE.Material[],
> extends THREE.Mesh<Geometry, Material> {}
