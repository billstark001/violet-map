import type { PreparedTopMapTile } from '@violet-map/core/formats/top-map';
import { meshByteLength, type MeshBuffers } from '@violet-map/render';
import { buildTopMapMesh } from '@violet-map/render/top-map/mesh';
import * as THREE from 'three';
import type { TopMapDisplay, TopMapTileDisplay } from '../runtime/topMapDisplay';
import { createTopMapMaterial, type SharedUniforms } from './materials';

interface Tile {
  data: PreparedTopMapTile;
  texture: THREE.DataTexture;
  material: THREE.ShaderMaterial;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null;
  step: number;
  coverageKey: string;
  meshBytes: number;
}

function createColorTexture(data: PreparedTopMapTile): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    data.colors,
    data.payload.size.colorSamples,
    data.payload.size.colorSamples,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function buildGeometry(b: MeshBuffers): { geometry: THREE.BufferGeometry; bytes: number } {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(b.positions, 3, true));
  if (b.uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(b.uvs, 2, true));
  geometry.setAttribute('tintColor', new THREE.BufferAttribute(b.colors, 3, true));
  geometry.setAttribute('lightData', new THREE.BufferAttribute(b.lights, 2, true));
  geometry.setIndex(new THREE.BufferAttribute(b.indices, 1));
  if (b.bounds) {
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(b.bounds.min[0], b.bounds.min[1], b.bounds.min[2]),
      new THREE.Vector3(b.bounds.max[0], b.bounds.max[1], b.bounds.max[2]),
    );
    const center = new THREE.Vector3();
    geometry.boundingBox.getCenter(center);
    const radius = center.distanceTo(new THREE.Vector3(b.bounds.max[0], b.bounds.max[1], b.bounds.max[2]));
    geometry.boundingSphere = new THREE.Sphere(center, radius);
  } else {
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }
  return { geometry, bytes: meshByteLength(b) };
}

function buildTileGeometry(
  data: PreparedTopMapTile,
  step: number,
  onlineChunkMask: Uint8Array | undefined,
): { geometry: THREE.BufferGeometry; bytes: number } | null {
  const buffers = buildTopMapMesh(data, { step, onlineChunkMask });
  if (!buffers || buffers.positions.length === 0 || buffers.indices.length === 0) return null;
  return buildGeometry(buffers);
}

/** Owns every Top Map GPU object; never chooses demand or starts IO. */
export class TopMapScene implements TopMapDisplay {
  private readonly group = new THREE.Group();
  private readonly tiles = new Map<string, Tile>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly shared: SharedUniforms,
  ) {
    this.group.visible = false;
    scene.add(this.group);
  }

  setEnabled(enabled: boolean) {
    this.group.visible = enabled;
  }

  add(key: string, data: PreparedTopMapTile) {
    if (this.tiles.has(key)) throw new Error('Top Map tile already has GPU resources: ' + key);
    const texture = createColorTexture(data);
    this.tiles.set(key, {
      data,
      texture,
      material: createTopMapMaterial(texture, this.shared),
      mesh: null,
      step: 0,
      coverageKey: '',
      meshBytes: 0,
    });
  }

  update(key: string, step: number, coverageKey: string, mask: Uint8Array | undefined) {
    const tile = this.tiles.get(key);
    if (!tile) throw new Error('Top Map tile has no GPU resources: ' + key);
    if (tile.step !== step || tile.coverageKey !== coverageKey) {
      const built = buildTileGeometry(tile.data, step, mask);
      tile.step = step;
      tile.coverageKey = coverageKey;
      if (!built) this.removeMesh(tile);
      else if (tile.mesh) {
        tile.mesh.geometry.dispose();
        tile.mesh.geometry = built.geometry;
        tile.meshBytes = built.bytes;
      } else {
        tile.mesh = new THREE.Mesh(built.geometry, tile.material);
        tile.mesh.position.set(tile.data.payload.origin.x, 0, tile.data.payload.origin.z);
        tile.mesh.matrixAutoUpdate = false;
        tile.mesh.updateMatrix();
        tile.meshBytes = built.bytes;
        this.group.add(tile.mesh);
      }
    }
    if (tile.mesh) tile.mesh.visible = true;
  }

  setWanted(wanted: ReadonlySet<string>) {
    for (const [key, tile] of this.tiles) if (tile.mesh) tile.mesh.visible = wanted.has(key);
  }

  snapshot(key: string): TopMapTileDisplay {
    const tile = this.tiles.get(key);
    if (!tile) throw new Error('Top Map tile has no GPU resources: ' + key);
    return { step: tile.step, coverageKey: tile.coverageKey, visible: !!tile.mesh?.visible, meshBytes: tile.meshBytes };
  }

  private removeMesh(tile: Tile) {
    if (tile.mesh) {
      this.group.remove(tile.mesh);
      tile.mesh.geometry.dispose();
      tile.mesh = null;
    }
    tile.meshBytes = 0;
  }

  remove(key: string) {
    const tile = this.tiles.get(key);
    if (!tile) return;
    this.removeMesh(tile);
    tile.material.dispose();
    tile.texture.dispose();
    this.tiles.delete(key);
  }

  private clear() {
    for (const key of this.tiles.keys()) this.remove(key);
  }

  dispose() {
    this.clear();
    this.scene.remove(this.group);
  }
}
