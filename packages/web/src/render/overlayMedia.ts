import type { MediaFeature, MediaVersion, OverlayMediaReference } from '@violet-map/core/overlays';
import { parseStaticGlb } from '@violet-map/core/overlays';
import * as THREE from 'three';
import { downloadResource } from '../resources/download';
import type { DisposableOverlayResource } from './overlayResources';

export interface OverlayMediaResource extends DisposableOverlayResource {
  instantiate(feature: MediaFeature): THREE.Object3D;
}

import { OVERLAY_LIMITS } from './overlayLimits';

function abort(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('overlay media aborted', 'AbortError');
}

function textureSet(materials: Iterable<THREE.Material>): Set<THREE.Texture> {
  const textures = new Set<THREE.Texture>();
  for (const material of materials)
    for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
  return textures;
}

function disposeTextures(textures: Iterable<THREE.Texture>) {
  const images = new Set<{ close: () => void }>();
  for (const texture of textures) {
    texture.dispose();
    const image = texture.source?.data as { width?: number; height?: number; close?: () => void } | undefined;
    if (image && typeof image.close === 'function') images.add(image as { close: () => void });
  }
  for (const image of images) image.close();
}

export function modelResource(scene: THREE.Group, ownedTextures: Iterable<THREE.Texture> = []): OverlayMediaResource {
  const geometries = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>();
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material])
        materials.add(material);
    }
  });
  const textures = new Set([...textureSet(materials), ...ownedTextures]),
    labels = new Map<THREE.Material, THREE.MeshBasicMaterial>();
  let bytes = 0;
  for (const geometry of geometries) {
    for (const attribute of Object.values(geometry.attributes)) bytes += attribute.array.byteLength;
    bytes += geometry.index?.array.byteLength ?? 0;
  }
  for (const texture of textures) {
    const image = texture.source?.data as { width?: number; height?: number; close?: () => void } | undefined;
    bytes += ((image?.width ?? 1) * (image?.height ?? 1) * 4 * 4) / 3;
  }
  let disposed = false;
  return {
    bytes,
    instantiate(feature) {
      if (disposed) throw new Error('media resource disposed');
      const copy = scene.clone(true);
      if (feature.lighting === 'label')
        copy.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          const label = (material: THREE.Material) => {
            let result = labels.get(material);
            if (result) return result;
            const original = material as THREE.MeshStandardMaterial;
            result = new THREE.MeshBasicMaterial({
              color: original.color?.clone() ?? 0xffffff,
              map: original.map,
              alphaMap: original.alphaMap,
              opacity: original.opacity,
              transparent: original.transparent,
              alphaTest: original.alphaTest,
              side: original.side,
              vertexColors: original.vertexColors,
              depthTest: original.depthTest,
              depthWrite: original.depthWrite,
              toneMapped: false,
            });
            labels.set(material, result);
            return result;
          };
          object.material = Array.isArray(object.material) ? object.material.map(label) : label(object.material);
        });
      return copy;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      for (const material of labels.values()) material.dispose();
      disposeTextures(textures);
      scene.clear();
    },
  };
}

async function imageResource(
  buffer: ArrayBuffer,
  version: MediaVersion,
  signal: AbortSignal,
  maxTextureSize: number,
): Promise<OverlayMediaResource> {
  const objectUrl = URL.createObjectURL(new Blob([buffer], { type: version.mediaType }));
  let bitmap: ImageBitmap | undefined;
  try {
    const source = new Image();
    source.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        source.onload = null;
        source.onerror = null;
        signal.removeEventListener('abort', cancel);
      };
      const cancel = () => {
        cleanup();
        source.src = '';
        reject(new DOMException('overlay image aborted', 'AbortError'));
      };
      source.onload = () => {
        cleanup();
        resolve();
      };
      source.onerror = () => {
        cleanup();
        reject(new Error('media image decoding failed'));
      };
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      else source.src = objectUrl;
    });
    abort(signal);
    const largest = Math.max(version.width!, version.height!),
      limit = Math.min(OVERLAY_LIMITS.mediaTexturePixels, maxTextureSize);
    const scale =
      version.mediaType === 'image/svg+xml'
        ? Math.min(limit / largest, Math.max(1, 1024 / largest))
        : Math.min(1, limit / largest);
    const width = Math.max(1, Math.round(version.width! * scale)),
      height = Math.max(1, Math.round(version.height! * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('image rasterization is unavailable');
    context.drawImage(source, 0, 0, width, height);
    bitmap = await createImageBitmap(canvas, { imageOrientation: 'flipY', premultiplyAlpha: 'none' });
    abort(signal);
    const texture = new THREE.Texture(bitmap);
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    const geometry = new THREE.PlaneGeometry(1, 1);
    const unlit = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    });
    let lit: THREE.MeshStandardMaterial | undefined,
      disposed = false;
    const resource: OverlayMediaResource = {
      bytes: Math.ceil((width * height * 4 * 4) / 3) + 140,
      instantiate(feature) {
        if (disposed) throw new Error('media resource disposed');
        if (feature.lighting === 'scene')
          lit ??= new THREE.MeshStandardMaterial({
            map: texture,
            transparent: true,
            side: THREE.DoubleSide,
            depthWrite: false,
            roughness: 1,
            metalness: 0,
          });
        const mesh = new THREE.Mesh(geometry, feature.lighting === 'scene' ? lit! : unlit);
        const [w, h] = feature.size!,
          [x, y] = feature.anchor!;
        mesh.scale.set(w, h, 1);
        mesh.position.set((0.5 - x) * w, (0.5 - y) * h, 0);
        const intrinsic = new THREE.Group();
        intrinsic.add(mesh);
        if (feature.placement === 'plane') intrinsic.rotation.x = -Math.PI / 2;
        return intrinsic;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        geometry.dispose();
        unlit.dispose();
        lit?.dispose();
        texture.dispose();
        bitmap?.close();
      },
    };
    return resource;
  } catch (error) {
    bitmap?.close();
    throw error;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function loadOverlayMedia(
  reference: OverlayMediaReference,
  signal: AbortSignal,
  maxTextureSize: number,
): Promise<OverlayMediaResource> {
  const { version } = reference;
  const buffer = (await downloadResource(reference.resource, signal)).buffer;
  abort(signal);
  if (version.mediaType !== 'model/gltf-binary') return imageResource(buffer, version, signal, maxTextureSize);
  parseStaticGlb(new Uint8Array(buffer));
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  abort(signal);
  const textures = new Set<THREE.Texture>();
  let failed: Error | undefined,
    finished = false;
  const loader = new GLTFLoader();
  loader.register((parser) => {
    const load = parser.loadImageSource.bind(parser);
    parser.loadImageSource = (...args) =>
      load(...args)
        .then((texture) => {
          if (finished) disposeTextures([texture]);
          else textures.add(texture);
          return texture;
        })
        .catch((error) => {
          failed = error instanceof Error ? error : new Error('GLB image decoding failed');
          throw error;
        });
    return { name: 'VioletMediaOwnership' };
  });
  try {
    const result = await loader.parseAsync(buffer, '');
    const resource = modelResource(result.scene, textures);
    textures.clear(); // Ownership has moved to the shared resource, including its failure cleanup.
    if (failed || signal.aborted) {
      resource.dispose();
      if (failed) throw failed;
      abort(signal);
    }
    return resource;
  } catch (error) {
    finished = true;
    disposeTextures(textures);
    throw error;
  }
}
