import * as THREE from 'three';

/** A mesh whose geometry and world bounds stay fixed throughout one frame's
 * render passes. Changes between frames still use Three's normal matrix updates.
 * Render callbacks may update uniforms, but must not change these bounds.
 */
export class StaticMesh<
  Geometry extends THREE.BufferGeometry = THREE.BufferGeometry,
  Material extends THREE.Material | THREE.Material[] = THREE.Material | THREE.Material[],
> extends THREE.Mesh<Geometry, Material> {
  private boundsGeometry: Geometry | null = null;
  private readonly localBounds = new THREE.Sphere();
  private readonly worldBounds = new THREE.Sphere();
  private readonly boundsMatrix = new THREE.Matrix4();

  intersectsFrustum(frustum: THREE.Frustum): boolean {
    const geometry = this.geometry;
    if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
    const bounds = geometry.boundingSphere!;
    if (
      this.boundsGeometry !== geometry ||
      !this.localBounds.equals(bounds) ||
      !this.boundsMatrix.equals(this.matrixWorld)
    ) {
      this.boundsGeometry = geometry;
      this.localBounds.copy(bounds);
      this.boundsMatrix.copy(this.matrixWorld);
      this.worldBounds.copy(bounds).applyMatrix4(this.matrixWorld);
    }
    return frustum.intersectsSphere(this.worldBounds);
  }
}
