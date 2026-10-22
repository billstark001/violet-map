import { TOP_MAP_POSITION_OFFSET, TOP_MAP_POSITION_SCALE } from '@violet-map/render/top-map/mesh';
import * as THREE from 'three';
import {
  createMaterials,
  createSharedUniforms,
  createTextureAnimationUniforms,
  createTopMapMaterial,
} from '../src/render/materials';
import { OVERLAY_RENDER_LIMITS } from '../src/render/overlayLimits';
import { OVERLAY_ADMISSION_LIMITS } from '../src/scheduling/overlayPolicy';
import { OVERLAY_RESOURCE_LIMITS } from '../src/resources/overlayLimits';
import { OverlayScene } from '../src/render/overlayScene';
import { OverlayRuntime, overlayTransport } from '../src/runtime/overlayRuntime';
import { createOverlayMediaLoader } from '../src/runtime/overlayMediaLoader';
import { decodeOverlayMedia } from '../src/render/overlayMedia';
import { TransparencyRenderer } from '../src/render/transparency';
import { resourceDownloader } from '../src/resources/download';
import { initializeRuntime } from '../src/runtime';

const query = new URLSearchParams(location.search);

await initializeRuntime({ fallbackApi: query.get('api')! });

THREE.ColorManagement.enabled = false;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });

renderer.setPixelRatio(1);

renderer.setSize(800, 600);

renderer.setClearColor(0x101010);

document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const transparency = new TransparencyRenderer(renderer);
const shared = createSharedUniforms();

shared.skyDarken.value = 1;

shared.ambient.value = 1;

shared.fogNear.value = 1e9;

shared.fogFar.value = 1e9 + 1;

shared.envFogDensity.value = 0;

const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);

texture.needsUpdate = true;

const animation = createTextureAnimationUniforms({
  ids: {},
  info: new Uint8Array(4),
  frames: new Uint8Array(4),
  infoSize: [1, 1],
  frameSize: [1, 1],
});
const materials = createMaterials(texture, shared, animation),
  top = createTopMapMaterial(texture, shared);
const terrain = new THREE.Group();

scene.add(terrain);

const overlayScene = new OverlayScene(scene, shared, createOverlayMediaLoader(decodeOverlayMedia));
const manager = new OverlayRuntime(overlayScene, overlayTransport);
const limits = { ...OVERLAY_RENDER_LIMITS, ...OVERLAY_ADMISSION_LIMITS, ...OVERLAY_RESOURCE_LIMITS };
const perspective = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 2000),
  orthographic = new THREE.OrthographicCamera(-80, 80, 60, -60, 0.1, 2000);
let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = orthographic,
  topView = true,
  sky: 'normal' | 'nether' | 'end' = 'normal',
  dayFactor = 1;
let cpu: number[] = [],
  intervals: number[] = [],
  lastFrame = 0;
let profiling = false;

function surface(mode: 'online' | 'lod' | 'topmap' | 'mixed' | 'none') {
  for (const object of [...terrain.children]) {
    terrain.remove(object);
    if (object instanceof THREE.Mesh) object.geometry.dispose();
  }
  if (mode === 'none') return;
  for (let index = 0; index < 3; index++) {
    const kind = mode === 'mixed' ? (['online', 'lod', 'topmap'] as const)[index] : mode;
    const material = kind === 'online' ? materials.opaque : kind === 'lod' ? materials.lod : top;
    const scale = kind === 'online' ? [18, 18, 18] : kind === 'lod' ? [16, 4096, 16] : TOP_MAP_POSITION_SCALE;
    const offset = kind === 'online' ? [-1, -1, -1] : kind === 'lod' ? [0, -2048, 0] : TOP_MAP_POSITION_OFFSET;
    const minX = -60 + index * 40,
      maxX = minX + 40,
      y = index * 12;
    const positions = [minX, y, -40, maxX, y, -40, maxX, y, 40, minX, y, 40];
    const encoded = positions.map((v, i) => (v - offset[i % 3]) / scale[i % 3]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(encoded, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geometry.setAttribute('tintColor', new THREE.Float32BufferAttribute(Array(12).fill(0.25), 3));
    geometry.setAttribute('lightData', new THREE.Float32BufferAttribute(Array(8).fill(1), 2));
    geometry.setIndex([0, 2, 1, 0, 3, 2]);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10000);
    terrain.add(new THREE.Mesh(geometry, material));
  }
}

function setCamera(
  mode: 'player' | 'topPerspective' | 'topOrthographic',
  position: [number, number, number] = [0, 150, 0],
  target: [number, number, number] = [0, 0, 0],
) {
  topView = mode !== 'player';
  camera = mode === 'topOrthographic' ? orthographic : perspective;
  camera.position.fromArray(position);
  camera.up.set(0, 0, -1);
  if (!topView) camera.up.set(0, 1, 0);
  camera.lookAt(...target);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}

function draw() {
  const start = performance.now();
  if (profiling) {
    if (lastFrame) intervals.push(start - lastFrame);
    lastFrame = start;
  }
  manager.tick(performance.now());
  overlayScene.render(renderer, {
    camera,
    topView,
    width: 800,
    height: 600,
    now: performance.now(),
    dayFactor,
    sky,
    ambient: 0.18,
    surfaceMaxY: 384,
  });
  transparency.render(scene, camera);
  if (profiling) cpu.push(performance.now() - start);
}

function pixel(point: [number, number, number]) {
  draw();
  const p = new THREE.Vector3(...point).project(camera),
    x = Math.floor((p.x + 1) * 400),
    y = Math.floor((p.y + 1) * 300),
    value = new Uint8Array(4);
  renderer.getContext().readPixels(x, y, 1, 1, renderer.getContext().RGBA, renderer.getContext().UNSIGNED_BYTE, value);
  return [...value];
}

function block(visible: boolean) {
  const existing = scene.getObjectByName('occluder');
  if (existing) {
    scene.remove(existing);
    const mesh = existing as THREE.Mesh;
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }
  if (visible) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(8, 24, 3), new THREE.MeshBasicMaterial({ color: 0x00ff00 }));
    mesh.name = 'occluder';
    mesh.position.set(0, 12, 20);
    scene.add(mesh);
  }
}

function water(visible: boolean) {
  const old = scene.getObjectByName('water') as THREE.Mesh | undefined;
  if (old) {
    scene.remove(old);
    old.geometry.dispose();
    const material = old.material as THREE.ShaderMaterial;
    (material.uniforms.map.value as THREE.Texture).dispose();
    material.dispose();
  }
  if (!visible) return;
  const map = new THREE.DataTexture(new Uint8Array([40, 100, 255, 128]), 1, 1);
  map.needsUpdate = true;
  const bundle = createMaterials(map, shared, animation),
    material = bundle.translucent;
  for (const unused of bundle.all) if (unused !== material) unused.dispose();
  const geometry = new THREE.BufferGeometry();
  const positions = [-25, 8, -25, 25, 8, -25, 25, 8, 25, -25, 8, 25];
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      positions.map((v) => (v + 1) / 18),
      3,
    ),
  );
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geometry.setAttribute('tintColor', new THREE.Float32BufferAttribute(Array(12).fill(1), 3));
  geometry.setAttribute('lightData', new THREE.Float32BufferAttribute(Array(8).fill(1), 2));
  geometry.setIndex([0, 2, 1, 0, 3, 2]);
  const object = new THREE.Mesh(geometry, material);
  object.name = 'water';
  scene.add(object);
}

surface('mixed');

setCamera('topOrthographic');

renderer.setAnimationLoop(draw);

const harness = {
  clearDownloads() {
    resourceDownloader.clear();
  },
  set: (mapId: string | null, dimension = 'overworld', enabled = true) => manager.configure(mapId, dimension, enabled),
  refresh: () => manager.refresh(),
  camera: setCamera,
  surface,
  block,
  water,
  pixel,
  lighting: (mode: 'normal' | 'nether' | 'end', day: number) => {
    sky = mode;
    dayFactor = day;
  },
  status: () => manager.diagnosticSnapshot(),
  memory: () => ({ ...renderer.info.memory, programs: renderer.info.programs?.length ?? 0 }),
  limits: () => limits,
  benchmark: async () => {
    cpu = [];
    intervals = [];
    lastFrame = 0;
    profiling = true;
    const checkpoints = [];
    let peakHeap = 0,
      peakMedia = 0,
      peakMask = 0,
      peakActive = 0,
      peakCurvePoints = 0;
    try {
      for (let frame = 0; frame < 180; frame++) {
        if (frame < 60) setCamera('topOrthographic', [-20 + (frame * 2) / 3, 150, 0], [-20 + (frame * 2) / 3, 0, 0]);
        else if (frame < 120)
          setCamera('topPerspective', [20 - ((frame - 60) * 2) / 3, 150, 0], [20 - ((frame - 60) * 2) / 3, 0, 0]);
        else if (frame < 140) setCamera('topOrthographic', [100000, 150, 100000], [100000, 0, 100000]);
        else setCamera('topOrthographic', [0, 150, 0], [0, 0, 0]);
        await new Promise(requestAnimationFrame);
        const status = manager.diagnosticSnapshot();
        peakMedia = Math.max(peakMedia, status.resourceBytes);
        peakMask = Math.max(peakMask, status.maskBytes);
        peakActive = Math.max(peakActive, status.active);
        peakCurvePoints = Math.max(peakCurvePoints, status.curvePoints);
        peakHeap = Math.max(
          peakHeap,
          (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0,
        );
        if ([59, 119, 139, 179].includes(frame))
          checkpoints.push({ frame, status, memory: { ...renderer.info.memory } });
      }
    } finally {
      profiling = false;
    }
    const summarize = (values: number[]) => {
      const sorted = values.slice().sort((a, b) => a - b);
      return {
        median: sorted[Math.floor(sorted.length / 2)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        max: sorted.at(-1),
      };
    };
    return {
      cpuMs: summarize(cpu),
      frameMs: summarize(intervals),
      heapBytes: peakHeap,
      peakMedia,
      peakMask,
      peakActive,
      peakCurvePoints,
      checkpoints,
      gpu: manager.diagnosticSnapshot(),
      memory: { ...renderer.info.memory },
    };
  },
  objects: () =>
    overlayScene.group.children.map((object) => ({
      position: object.position.toArray(),
      scale: object.scale.toArray(),
      bounds: (() => {
        const box = new THREE.Box3().setFromObject(object);
        return { min: box.min.toArray(), max: box.max.toArray() };
      })(),
    })),
  dispose: () => {
    manager.dispose();
    transparency.dispose();
    renderer.setAnimationLoop(null);
  },
};

export type OverlayHarness = typeof harness;

declare global {
  interface Window {
    overlayHarness: OverlayHarness;
  }
}

window.overlayHarness = harness;
