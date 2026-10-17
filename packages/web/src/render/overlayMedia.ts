import * as THREE from 'three';
import type { MediaFeature, MediaVersion, OverlayMediaReference } from '@violet-map/core/overlays';
import { resolveApiResourceUrl } from '../runtime';
import type { DisposableOverlayResource } from './overlayResources';
import { publicResourceUrl, readLimitedBody } from '@violet-map/core/http';

export interface OverlayMediaResource extends DisposableOverlayResource {
  instantiate(feature: MediaFeature): THREE.Object3D;
}

import { OVERLAY_LIMITS } from './overlayLimits';

function abort(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('overlay media aborted', 'AbortError');
}

async function digest(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

export function validateStaticGlb(buffer: ArrayBuffer): void {
  const view = new DataView(buffer);
  if (
    buffer.byteLength < 20 ||
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== buffer.byteLength ||
    view.getUint32(16, true) !== 0x4e4f534a ||
    20 + view.getUint32(12, true) > buffer.byteLength
  )
    throw new Error('invalid GLB 2.0 container');
  const json: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(buffer, 20, view.getUint32(12, true))),
  );
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['extensions', 'extensionsUsed', 'extensionsRequired'].includes(key) && child && Object.keys(child).length)
        throw new Error(`unsupported static GLB ${key}`);
      visit(child);
    }
  };
  visit(json);
  const model = json as {
    animations?: unknown[];
    skins?: unknown[];
    buffers?: { uri?: string }[];
    images?: { uri?: string; bufferView?: number; mimeType?: string }[];
    nodes?: { skin?: number }[];
    meshes?: { primitives: { targets?: unknown[] }[] }[];
  };
  if (
    model.animations?.length ||
    model.skins?.length ||
    model.nodes?.some((node) => node.skin !== undefined) ||
    model.meshes?.some((mesh) => mesh.primitives.some((p) => p.targets?.length))
  )
    throw new Error('GLB animation, skins and morph targets are unsupported');
  if (
    model.buffers?.some((buffer) => buffer.uri !== undefined) ||
    model.images?.some(
      (image) =>
        image.uri !== undefined ||
        image.bufferView === undefined ||
        !['image/png', 'image/jpeg'].includes(image.mimeType ?? ''),
    )
  )
    throw new Error('GLB dependencies must be embedded PNG/JPEG buffer views');
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

/** Fetch pinned bytes anonymously, retrying the API proxy if public delivery fails.
 * Both transports share one timeout, size budget and digest verification. */
export async function fetchOverlayMediaBytes(
  reference: OverlayMediaReference,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const { version } = reference;
  if (version.bytes > OVERLAY_LIMITS.downloadBytes) throw new Error('media exceeds the 64 MiB viewer download limit');
  const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const fetchBytes = async (url: string) => {
    abort(downloadSignal);
    const response = await fetch(url, { signal: downloadSignal, credentials: 'omit', redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`media ${version.assetId}/${version.versionId}: HTTP ${response.status}`);
    }
    const bytes = await readLimitedBody(response, version.bytes);
    abort(downloadSignal);
    if (!bytes || bytes.byteLength !== version.bytes)
      throw new Error('media digest/size does not match its pinned version');
    const buffer = bytes.buffer as ArrayBuffer;
    if ((await digest(buffer)) !== version.digest)
      throw new Error('media digest/size does not match its pinned version');
    abort(downloadSignal);
    return buffer;
  };
  if (reference.publicUrl) {
    const publicUrl = publicResourceUrl(reference.publicUrl);
    try {
      return await fetchBytes(publicUrl);
    } catch {
      abort(downloadSignal);
    }
  }
  return fetchBytes(resolveApiResourceUrl(reference.url));
}

export async function loadOverlayMedia(
  reference: OverlayMediaReference,
  signal: AbortSignal,
  maxTextureSize: number,
): Promise<OverlayMediaResource> {
  const { version } = reference;
  const buffer = await fetchOverlayMediaBytes(reference, signal);
  abort(signal);
  if (version.mediaType !== 'model/gltf-binary') return imageResource(buffer, version, signal, maxTextureSize);
  validateStaticGlb(buffer);
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
