import { loadBrowserImage } from '../browserImage';
import { buildRenderKey } from './resourceKey';
import * as THREE from 'three';
import type { BiomeMap, DimensionMap } from '@violet-map/core/domain';
import { hexToRgb } from '@violet-map/render';
import { fetchBiomes, fetchBlockInfo, fetchBundle, fetchDimensions, fetchWorldCapabilities, textureUrl } from '../api';
import { type WorldCapabilities } from '@violet-map/core/contracts';
import { buildAtlas, collectTextureIds, loadColormap } from '../atlas';
import { ChunkManager, type ChunkManagerDiagnosticSnapshot, type TopClipRange } from './chunkManager';
import {
  EMPTY_CHUNK_SCHEDULER_STATS,
  schedulerTuningForPreset,
  type ChunkSchedulerStats,
  type SchedulerPreset,
} from './chunkScheduler';
import { clampFlyPitch, FlyControls, normalizeFlyYaw, TopDownControls, type FlyView } from './controls';
import {
  createMaterials,
  createSharedUniforms,
  createTextureAnimationUniforms,
  type SharedUniforms,
  type TerrainMaterials,
  type TextureAnimationUniforms,
} from './materials';
import { TopMapManager, type TopMapDiagnosticSnapshot } from './topMapManager';
import { OverlayManager, type OverlayDiagnosticSnapshot } from './overlayManager';
import { serviceCapabilities } from '../runtime';
import type { WorkerInit } from '../worker/protocol';
import { browserStorage, readStored } from '../browserStorage';
import {
  VIEW_STORAGE_KEY,
  readInitialView,
  buildViewUrl,
  lookAtTargetFromParams,
  type InitialView,
} from './cameraState';

// Fluid UVs, exterior AO for partial models, and special-model transforms all
// changed mesh bytes. Keep stale IndexedDB entries from reviving the old
// water/stair artifacts after an upgrade.
const SKY_PLANE_FORWARD = new THREE.Vector3(0, 0, 1);
const TOP_CAMERA_HEIGHT = 1024;
const TOP_ORTHO_HEIGHT = 512;
const TOP_PERSPECTIVE_FOV = 50;
const TOP_MAP_FREE_VIEW_MAX_DISTANCE_CHUNKS = 1024;
const TOP_MAP_FREE_VIEW_MAX_DISTANCE_BLOCKS = TOP_MAP_FREE_VIEW_MAX_DISTANCE_CHUNKS * 16;
const LONG_RANGE_CAMERA_FAR = TOP_MAP_FREE_VIEW_MAX_DISTANCE_BLOCKS + 2 * 512;
const DEFAULT_DIMENSION_DEF = {
  hasSkyLight: true,
  ambientLight: 0.18,
  sky: 'normal' as const,
  defaultBiome: 'minecraft:plains',
};
const celestialFacing = new THREE.Vector3();
const cameraDirection = new THREE.Vector3();
const sunDirection = new THREE.Vector3();
const moonDirection = new THREE.Vector3();

export type ViewMode = 'perspective' | 'topPerspective' | 'topOrthographic';

export interface CameraPositionRequest {
  x: number;
  y: number;
  z: number;
  yaw?: number;
  pitch?: number;
  seq: number;
}

export interface ViewerOptions {
  world: string;
  overlayMapId?: string;
  overlaysEnabled?: boolean;
  onOverlayStatus?: (status: OverlayDiagnosticSnapshot) => void;
  dimension: string;
  viewDistance: number;
  lodDistance: number;
  schedulerPreset: SchedulerPreset;
  fastMoveMultiplier: number;
  inertiaEnabled: boolean;
  viewMode: ViewMode;
  topClipRange: TopClipRange;
  timeOfDay: number; // 0=正午, 0.5=午夜
  cameraTarget?: CameraPositionRequest;
  onStats?: (s: ViewerStatsPayload) => void;
  onDiagnosticSnapshotProvider?: (provider: (() => ViewerDiagnosticSnapshot | null) | null) => void;
}

export type ViewerStatsPayload = ChunkSchedulerStats & {
  pos: [number, number, number];
  yaw: number;
  pitch: number;
  viewMode: ViewMode;
};

export interface ViewerDiagnosticSnapshot {
  schema: 1;
  capturedAt: string;
  browser: {
    userAgent: string;
    language: string;
    devicePixelRatio: number;
  };
  camera: ViewerStatsPayload;
  schedulerPreset: SchedulerPreset;
  chunkManager: ChunkManagerDiagnosticSnapshot | null;
  topMap: TopMapDiagnosticSnapshot;
  overlays: OverlayDiagnosticSnapshot;
}

type ActiveCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

type ViewerBundle = Awaited<ReturnType<typeof fetchBundle>>;

type ViewerBlockInfo = Awaited<ReturnType<typeof fetchBlockInfo>>;

type ViewerAtlas = Awaited<ReturnType<typeof buildAtlas>>;

type ViewerDimensionDef = DimensionMap[string] | typeof DEFAULT_DIMENSION_DEF;

interface ViewerResources {
  bundle: ViewerBundle;
  blockInfo: ViewerBlockInfo;
  biomes: BiomeMap;
  dimensions: DimensionMap;
  grassMap: Uint8Array | null;
  foliageMap: Uint8Array | null;
  atlas: ViewerAtlas;
  renderKey: string;
}

interface Engine {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  perspectiveCamera: THREE.PerspectiveCamera;
  topPerspectiveCamera: THREE.PerspectiveCamera;
  topOrthographicCamera: THREE.OrthographicCamera;
  activeCamera: ActiveCamera;
  flyControls: FlyControls;
  topPerspectiveControls: TopDownControls;
  topOrthographicControls: TopDownControls;
  topMap: TopMapManager;
  overlays: OverlayManager;
  materials: TerrainMaterials;
  terrainTexture: THREE.Texture;
  textureAnimations: TextureAnimationUniforms;
  shared: SharedUniforms;
  sky: SkyObjects;
  renderKey: string;
  initPayload: Omit<WorkerInit, 'type'>;
  biomes: BiomeMap;
  dimensions: DimensionMap;
}

interface SkyObjects {
  group: THREE.Group;
  dome: THREE.Mesh;
  domeMaterial: THREE.ShaderMaterial;
  sun: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  moon: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  stars: THREE.Points;
  dispose(): void;
}

interface ViewerCameras {
  perspectiveCamera: THREE.PerspectiveCamera;
  topPerspectiveCamera: THREE.PerspectiveCamera;
  topOrthographicCamera: THREE.OrthographicCamera;
}

interface ViewerControls {
  flyControls: FlyControls;
  topPerspectiveControls: TopDownControls;
  topOrthographicControls: TopDownControls;
}

interface FrameState {
  timer: THREE.Timer;
  skyColor: THREE.Color;
  horizonColor: THREE.Color;
  activeViewMode: ViewMode;
  lastStatsReport: number;
  lastPersist: number;
  lastUrlPersist: number;
}

interface FrameContext {
  engine: Engine;
  manager: ChunkManager | null;
  latestStats: ChunkSchedulerStats;
  props: ViewerOptions;
  capabilities: WorldCapabilities | null;
  state: FrameState;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function persistView(view: FlyView, updateUrl: boolean) {
  try {
    browserStorage('localStorage')?.setItem(VIEW_STORAGE_KEY, JSON.stringify(view));
  } catch {
    // Storage can be unavailable in private or restricted contexts.
  }
  if (updateUrl) {
    try {
      history.replaceState(null, '', buildViewUrl(location.pathname, location.search, location.hash, view));
    } catch {
      // Sandboxed frames and browser history rate limits must not interrupt a frame.
    }
  }
}

function cameraView(camera: THREE.Camera, yaw: number, pitch: number): FlyView {
  return {
    x: camera.position.x,
    y: camera.position.y,
    z: camera.position.z,
    yaw: normalizeFlyYaw(yaw),
    pitch: clampFlyPitch(pitch),
  };
}

function resizeTopCamera(camera: THREE.OrthographicCamera, width: number, height: number) {
  const aspect = width / Math.max(1, height);
  camera.left = (-TOP_ORTHO_HEIGHT * aspect) / 2;
  camera.right = (TOP_ORTHO_HEIGHT * aspect) / 2;
  camera.top = TOP_ORTHO_HEIGHT / 2;
  camera.bottom = -TOP_ORTHO_HEIGHT / 2;
  camera.updateProjectionMatrix();
}

function isTopViewMode(mode: ViewMode): boolean {
  return mode === 'topPerspective' || mode === 'topOrthographic';
}

function cameraForMode(engine: Engine, mode: ViewMode): ActiveCamera {
  if (mode === 'topPerspective') return engine.topPerspectiveCamera;
  if (mode === 'topOrthographic') return engine.topOrthographicCamera;
  return engine.perspectiveCamera;
}

function setControlsEnabled(engine: Engine, mode: ViewMode) {
  engine.flyControls.setEnabled(mode === 'perspective');
  engine.topPerspectiveControls.setEnabled(mode === 'topPerspective');
  engine.topOrthographicControls.setEnabled(mode === 'topOrthographic');
}

function cameraOrientation(camera: THREE.Camera): { yaw: number; pitch: number } {
  camera.getWorldDirection(cameraDirection);
  return {
    yaw: normalizeFlyYaw(Math.atan2(-cameraDirection.x, -cameraDirection.z)),
    pitch: clampFlyPitch(Math.asin(THREE.MathUtils.clamp(cameraDirection.y, -1, 1))),
  };
}

function orientationForMode(camera: THREE.Camera, viewMode: ViewMode): { yaw: number; pitch: number } {
  if (isTopViewMode(viewMode)) return { yaw: 0, pitch: -Math.PI / 2 };
  return cameraOrientation(camera);
}

function statsForCamera(s: ChunkSchedulerStats, camera: THREE.Camera, viewMode: ViewMode): ViewerStatsPayload {
  const orientation = orientationForMode(camera, viewMode);
  return {
    ...s,
    pos: [camera.position.x, camera.position.y, camera.position.z],
    yaw: orientation.yaw,
    pitch: orientation.pitch,
    viewMode,
  };
}

function diagnosticSnapshotForViewer(
  engine: Engine,
  manager: ChunkManager | null,
  stats: ChunkSchedulerStats,
  viewMode: ViewMode,
  schedulerPreset: SchedulerPreset,
): ViewerDiagnosticSnapshot {
  return {
    schema: 1,
    capturedAt: new Date().toISOString(),
    browser: {
      userAgent: navigator.userAgent,
      language: navigator.language,
      devicePixelRatio: window.devicePixelRatio,
    },
    camera: statsForCamera(stats, engine.activeCamera, viewMode),
    schedulerPreset,
    chunkManager: manager?.diagnosticSnapshot() ?? null,
    topMap: engine.topMap.diagnosticSnapshot(),
    overlays: engine.overlays.diagnosticSnapshot(),
  };
}

function topMapAvailable(capabilities: WorldCapabilities | null, dimension: string): boolean {
  return capabilities?.dimensions[dimension]?.hasTopMap === true;
}

function dimensionDefinition(dimensions: DimensionMap, dimension: string): ViewerDimensionDef {
  return dimensions[dimension] ?? DEFAULT_DIMENSION_DEF;
}

async function loadViewerResources(signal: AbortSignal): Promise<ViewerResources> {
  const [bundle, blockInfo, biomes, dimensions, grassMap, foliageMap] = await Promise.all([
    fetchBundle(signal),
    fetchBlockInfo(signal),
    fetchBiomes(signal),
    fetchDimensions(signal),
    loadColormap('minecraft:colormap/grass', signal),
    loadColormap('minecraft:colormap/foliage', signal),
  ]);
  const atlas = await buildAtlas(
    collectTextureIds(bundle, blockInfo),
    new Set(Object.keys(bundle.textureAnimations ?? {})),
    signal,
  );
  return {
    bundle,
    blockInfo,
    biomes,
    dimensions,
    grassMap,
    foliageMap,
    atlas,
    renderKey: buildRenderKey({
      atlasKey: atlas.cacheKey,
      bundle,
      blockInfo,
      biomes,
      dimensions,
      grassMap,
      foliageMap,
    }),
  };
}

function configurePixelTexture(texture: THREE.Texture): THREE.Texture {
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

function createTerrainTexture(atlas: ViewerAtlas, renderer: THREE.WebGLRenderer): THREE.Texture {
  const texture = new THREE.CanvasTexture(atlas.canvas);
  texture.flipY = false;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function makeCelestialFallback(kind: 'sun' | 'moon'): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 32, 32);
  ctx.imageSmoothingEnabled = false;
  if (kind === 'sun') {
    ctx.fillStyle = '#fff7b2';
    ctx.fillRect(4, 4, 24, 24);
    ctx.fillStyle = '#ffd96a';
    ctx.fillRect(7, 7, 18, 18);
  } else {
    ctx.fillStyle = '#d8dce8';
    ctx.fillRect(6, 6, 20, 20);
    ctx.fillStyle = '#aeb5c5';
    ctx.fillRect(9, 9, 4, 4);
    ctx.fillRect(18, 14, 4, 4);
    ctx.fillRect(13, 21, 3, 3);
  }
  return canvas;
}

function loadCanvasBackedTexture(
  fallback: HTMLCanvasElement,
  candidates: { id: string; cropMoonSheet?: boolean }[],
  signal: AbortSignal,
): THREE.Texture {
  const texture = configurePixelTexture(new THREE.CanvasTexture(fallback));
  const tryLoad = (index: number) => {
    const candidate = candidates[index];
    if (!candidate || signal.aborted) return;
    void loadBrowserImage(textureUrl(candidate.id), signal)
      .then((img) => {
        if (signal.aborted) return;
        if (candidate.cropMoonSheet && img.width > img.height) {
          const frameW = Math.floor(img.width / 4);
          const frameH = Math.floor(img.height / 2);
          const canvas = document.createElement('canvas');
          canvas.width = frameW;
          canvas.height = frameH;
          const ctx = canvas.getContext('2d')!;
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(img, 0, 0, frameW, frameH, 0, 0, frameW, frameH);
          texture.image = canvas;
        } else {
          texture.image = img;
        }
        texture.needsUpdate = true;
      })
      .catch(() => {
        if (!signal.aborted) tryLoad(index + 1);
      });
  };
  tryLoad(0);
  return texture;
}

function createCelestialMaterial(texture: THREE.Texture): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    map: texture,
    color: 0xffffff,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
  });
}

function createSkyDomeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(0x78a7ff) },
      horizonColor: { value: new THREE.Color(0xb9d4ff) },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },
      sunsetAmount: { value: 0 },
      nightAmount: { value: 0 },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      uniform vec3 sunDir;
      uniform float sunsetAmount;
      uniform float nightAmount;
      varying vec3 vDir;
      void main() {
        vec3 dir = normalize(vDir);
        float vertical = smoothstep(-0.08, 0.58, dir.y);
        vec3 color = mix(horizonColor, topColor, vertical);
        float sunDot = max(dot(normalize(sunDir), dir), 0.0);
        float diskGlow = pow(sunDot, 18.0) * sunsetAmount;
        float horizonGlow = (1.0 - vertical) * smoothstep(-0.12, 0.24, dir.y) * sunsetAmount;
        vec3 warm = vec3(1.0, 0.48, 0.16);
        color = mix(color, warm, clamp(diskGlow * 0.75 + horizonGlow * 0.38, 0.0, 0.78));
        color = mix(color, vec3(0.012, 0.016, 0.035), nightAmount * 0.86);
        gl_FragColor = vec4(color, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
}

function createSkyObjects(scene: THREE.Scene): SkyObjects {
  const textures = new AbortController();
  const group = new THREE.Group();
  const domeMaterial = createSkyDomeMaterial();
  const domeGeometry = new THREE.SphereGeometry(1200, 32, 16);
  const dome = new THREE.Mesh(domeGeometry, domeMaterial);
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  group.add(dome);

  const sunTexture = loadCanvasBackedTexture(
    makeCelestialFallback('sun'),
    [{ id: 'minecraft:environment/celestial/sun' }, { id: 'minecraft:environment/sun' }],
    textures.signal,
  );
  const moonTexture = loadCanvasBackedTexture(
    makeCelestialFallback('moon'),
    [
      { id: 'minecraft:environment/celestial/moon/full_moon' },
      { id: 'minecraft:environment/moon_phases', cropMoonSheet: true },
    ],
    textures.signal,
  );
  const celestialGeometry = new THREE.PlaneGeometry(1, 1);
  const sun = new THREE.Mesh(celestialGeometry, createCelestialMaterial(sunTexture));
  const moon = new THREE.Mesh(celestialGeometry, createCelestialMaterial(moonTexture));
  sun.frustumCulled = false;
  moon.frustumCulled = false;
  sun.renderOrder = -900;
  moon.renderOrder = -900;
  sun.scale.set(180, 180, 1);
  moon.scale.set(120, 120, 1);
  group.add(sun, moon);

  const starsCount = 900;
  const positions = new Float32Array(starsCount * 3);
  let seed = 1337;
  const rand = () => {
    seed = Math.imul(seed ^ (seed >>> 15), 2246822507);
    seed = Math.imul(seed ^ (seed >>> 13), 3266489909);
    return ((seed ^= seed >>> 16) >>> 0) / 0xffffffff;
  };
  for (let i = 0; i < starsCount; i++) {
    const y = 0.16 + rand() * 0.84;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    positions[i * 3] = Math.cos(a) * r * 900;
    positions[i * 3 + 1] = y * 900;
    positions[i * 3 + 2] = Math.sin(a) * r * 900;
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const starMaterial = new THREE.PointsMaterial({
    color: 0xdde6ff,
    size: 2,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const stars = new THREE.Points(starGeometry, starMaterial);
  group.add(stars);
  scene.add(group);

  return {
    group,
    dome,
    domeMaterial,
    sun,
    moon,
    stars,
    dispose() {
      textures.abort();
      scene.remove(group);
      domeGeometry.dispose();
      domeMaterial.dispose();
      celestialGeometry.dispose();
      sunTexture.dispose();
      moonTexture.dispose();
      sun.material.dispose();
      moon.material.dispose();
      starGeometry.dispose();
      starMaterial.dispose();
    },
  };
}

function updateSkyObjects(
  sky: SkyObjects,
  camera: THREE.Camera,
  timeOfDay: number,
  dayFactor: number,
  visible: boolean,
  topColor: THREE.Color,
  horizonColor: THREE.Color,
) {
  sky.group.position.copy(camera.position);
  sky.group.visible = visible;
  if (!visible) return;
  const angle = timeOfDay * Math.PI * 2;
  const sunDir = sunDirection.set(Math.sin(angle), Math.cos(angle), -0.25).normalize();
  const moonDir = moonDirection.copy(sunDir).multiplyScalar(-1);
  sky.sun.position.copy(sunDir).multiplyScalar(850);
  sky.moon.position.copy(moonDir).multiplyScalar(850);
  sky.sun.quaternion.setFromUnitVectors(SKY_PLANE_FORWARD, celestialFacing.copy(sunDir).negate());
  sky.moon.quaternion.setFromUnitVectors(SKY_PLANE_FORWARD, celestialFacing.copy(moonDir).negate());
  const night = clamp01((0.55 - dayFactor) / 0.55);
  const sunset = Math.max(0, 1 - Math.abs(sunDir.y) / 0.34) * Math.min(1, dayFactor * 1.6);
  sky.domeMaterial.uniforms.topColor.value.copy(topColor);
  sky.domeMaterial.uniforms.horizonColor.value.copy(horizonColor);
  sky.domeMaterial.uniforms.sunDir.value.copy(sunDir);
  sky.domeMaterial.uniforms.sunsetAmount.value = sunset;
  sky.domeMaterial.uniforms.nightAmount.value = night;
  sky.sun.material.opacity = clamp01(dayFactor * 1.2);
  sky.moon.material.opacity = night * 0.8;
  (sky.stars.material as THREE.PointsMaterial).opacity = night * 0.85;
}

function createRenderer(container: HTMLElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    alpha: false,
    depth: true,
    stencil: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  });
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const pixelRatioCap = memory !== undefined && memory <= 4 ? 1 : 1.5;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, pixelRatioCap));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);
  return renderer;
}

function createScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x78a7ff);
  return scene;
}

function createPerspectiveCamera(
  container: HTMLElement,
  initialView: InitialView,
  params: URLSearchParams,
): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(
    75,
    container.clientWidth / container.clientHeight,
    0.1,
    LONG_RANGE_CAMERA_FAR,
  );
  camera.rotation.order = 'YXZ';
  camera.position.set(initialView.x, initialView.y, initialView.z);
  const lookAtTarget = initialView.hasAngles ? null : lookAtTargetFromParams(params, camera.position);
  if (lookAtTarget) camera.lookAt(...lookAtTarget);
  return camera;
}

function createTopPerspectiveCamera(container: HTMLElement, initialView: InitialView): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(
    TOP_PERSPECTIVE_FOV,
    container.clientWidth / Math.max(1, container.clientHeight),
    1,
    LONG_RANGE_CAMERA_FAR,
  );
  camera.rotation.order = 'YXZ';
  camera.position.set(initialView.x, Math.max(TOP_CAMERA_HEIGHT, initialView.y), initialView.z);
  camera.rotation.set(-Math.PI / 2, 0, 0);
  camera.updateProjectionMatrix();
  return camera;
}

function createTopOrthographicCamera(container: HTMLElement, initialView: InitialView): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera();
  resizeTopCamera(camera, container.clientWidth, container.clientHeight);
  camera.near = -2000;
  camera.far = 3000;
  camera.position.set(initialView.x, Math.max(TOP_CAMERA_HEIGHT, initialView.y), initialView.z);
  camera.rotation.order = 'YXZ';
  camera.rotation.set(-Math.PI / 2, 0, 0);
  camera.updateProjectionMatrix();
  return camera;
}

function createCameras(container: HTMLElement, initialView: InitialView): ViewerCameras {
  const params = new URLSearchParams(location.search);
  return {
    perspectiveCamera: createPerspectiveCamera(container, initialView, params),
    topPerspectiveCamera: createTopPerspectiveCamera(container, initialView),
    topOrthographicCamera: createTopOrthographicCamera(container, initialView),
  };
}

function createControls(
  domElement: HTMLElement,
  cameras: ViewerCameras,
  initialView: InitialView,
  fastMoveMultiplier: number,
  inertiaEnabled: boolean,
): ViewerControls {
  const flyControls = new FlyControls(
    domElement,
    cameras.perspectiveCamera,
    initialView.hasAngles ? { yaw: initialView.yaw, pitch: initialView.pitch } : undefined,
  );
  flyControls.setFastMultiplier(fastMoveMultiplier);
  flyControls.setInertiaEnabled(inertiaEnabled);

  const topPerspectiveControls = new TopDownControls(domElement, cameras.topPerspectiveCamera);
  topPerspectiveControls.setFastMultiplier(fastMoveMultiplier);

  const topOrthographicControls = new TopDownControls(domElement, cameras.topOrthographicCamera);
  topOrthographicControls.setFastMultiplier(fastMoveMultiplier);

  return { flyControls, topPerspectiveControls, topOrthographicControls };
}

function createInitPayload(resources: ViewerResources): Omit<WorkerInit, 'type'> {
  return {
    bundle: resources.bundle,
    blockInfo: resources.blockInfo,
    biomes: resources.biomes,
    atlasIndex: resources.atlas.index,
    avgColors: resources.atlas.avgColors,
    textureHasAlpha: resources.atlas.hasAlpha,
    textureAnimationIds: resources.atlas.animations.ids,
    grassColormap: resources.grassMap,
    foliageColormap: resources.foliageMap,
  };
}

function createEngine(
  container: HTMLElement,
  resources: ViewerResources,
  initialView: InitialView,
  initialViewMode: ViewMode,
  fastMoveMultiplier: number,
  inertiaEnabled: boolean,
): Engine {
  const renderer = createRenderer(container);
  const scene = createScene();
  const skyObjects = createSkyObjects(scene);
  const cameras = createCameras(container, initialView);
  const terrainTexture = createTerrainTexture(resources.atlas, renderer);
  const shared = createSharedUniforms();
  const textureAnimations = createTextureAnimationUniforms(resources.atlas.animations);
  const materials = createMaterials(terrainTexture, shared, textureAnimations);
  const controls = createControls(renderer.domElement, cameras, initialView, fastMoveMultiplier, inertiaEnabled);
  const topMap = new TopMapManager(scene, shared);

  const engine: Engine = {
    renderer,
    scene,
    perspectiveCamera: cameras.perspectiveCamera,
    topPerspectiveCamera: cameras.topPerspectiveCamera,
    topOrthographicCamera: cameras.topOrthographicCamera,
    activeCamera: cameras.perspectiveCamera,
    flyControls: controls.flyControls,
    topPerspectiveControls: controls.topPerspectiveControls,
    topOrthographicControls: controls.topOrthographicControls,
    topMap,
    overlays: new OverlayManager(scene, shared),
    materials,
    terrainTexture,
    textureAnimations,
    shared,
    sky: skyObjects,
    biomes: resources.biomes,
    dimensions: resources.dimensions,
    renderKey: resources.renderKey,
    initPayload: createInitPayload(resources),
  };
  engine.activeCamera = cameraForMode(engine, initialViewMode);
  setControlsEnabled(engine, initialViewMode);
  return engine;
}

function createResizeHandler(engine: Engine, container: HTMLElement): () => void {
  return () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    engine.perspectiveCamera.aspect = width / Math.max(1, height);
    engine.perspectiveCamera.updateProjectionMatrix();
    engine.topPerspectiveControls.resize(width / Math.max(1, height), TOP_ORTHO_HEIGHT);
    resizeTopCamera(engine.topOrthographicCamera, width, height);
    engine.topOrthographicControls.resize(width / Math.max(1, height), TOP_ORTHO_HEIGHT);
    engine.renderer.setSize(width, height);
  };
}

function disposeEngine(engine: Engine) {
  engine.renderer.setAnimationLoop(null);
  engine.flyControls.dispose();
  engine.topPerspectiveControls.dispose();
  engine.topOrthographicControls.dispose();
  engine.topMap.dispose();
  engine.overlays.dispose();
  engine.sky.dispose();
  for (const material of engine.materials.all) material.dispose();
  engine.textureAnimations.info.dispose();
  engine.textureAnimations.frames.dispose();
  engine.terrainTexture.dispose();
  engine.renderer.renderLists.dispose();
  engine.renderer.dispose();
  engine.renderer.forceContextLoss();
  engine.renderer.domElement.remove();
}

function createFrameState(initialViewMode: ViewMode): FrameState {
  return {
    timer: new THREE.Timer(),
    skyColor: new THREE.Color(),
    horizonColor: new THREE.Color(),
    activeViewMode: initialViewMode,
    lastStatsReport: 0,
    lastPersist: 0,
    lastUrlPersist: 0,
  };
}

function syncViewMode(engine: Engine, currentMode: ViewMode, nextMode: ViewMode): ViewMode {
  if (currentMode === nextMode) return currentMode;
  const source = engine.activeCamera;
  if (isTopViewMode(nextMode)) {
    const targetControls =
      nextMode === 'topPerspective' ? engine.topPerspectiveControls : engine.topOrthographicControls;
    targetControls.setPosition(source.position.x, Math.max(TOP_CAMERA_HEIGHT, source.position.y), source.position.z);
    engine.activeCamera = cameraForMode(engine, nextMode);
  } else {
    engine.flyControls.setPosition(source.position.x, engine.perspectiveCamera.position.y, source.position.z);
    engine.activeCamera = engine.perspectiveCamera;
  }
  setControlsEnabled(engine, nextMode);
  return nextMode;
}

function updateActiveControls(engine: Engine, viewMode: ViewMode, dt: number) {
  if (viewMode === 'topPerspective') engine.topPerspectiveControls.update(dt);
  else if (viewMode === 'topOrthographic') engine.topOrthographicControls.update(dt);
  else engine.flyControls.update(dt);
}

function updateChunksAndTopMap(
  engine: Engine,
  manager: ChunkManager | null,
  props: ViewerOptions,
  capabilities: WorldCapabilities | null,
  now: number,
): ViewerDimensionDef {
  const topView = isTopViewMode(props.viewMode);
  const dimDef = dimensionDefinition(engine.dimensions, props.dimension);
  const offlineTopMap = topMapAvailable(capabilities, props.dimension);

  engine.topMap.configure(props.world, props.dimension, offlineTopMap);
  if (manager) manager.root.visible = true;
  manager?.update(engine.activeCamera, now, false, topView, props.topClipRange);
  engine.topMap.update(engine.activeCamera, now, {
    mode: topView ? 'top' : 'perspective',
    radiusBlocks: TOP_MAP_FREE_VIEW_MAX_DISTANCE_BLOCKS,
    maxDistanceBlocks: TOP_MAP_FREE_VIEW_MAX_DISTANCE_BLOCKS,
    onlineChunks: manager?.displayedChunkKeys(),
  });

  return dimDef;
}

function dayFactorForDimension(dimDef: ViewerDimensionDef, timeOfDay: number): number {
  if (!dimDef?.hasSkyLight) return 0;
  return clamp01(Math.cos(timeOfDay * Math.PI * 2) * 2 + 0.5);
}

function resolveBiomeName(manager: ChunkManager | null, dimDef: ViewerDimensionDef, camera: THREE.Camera): string {
  const ccx = Math.floor(camera.position.x / 16);
  const ccz = Math.floor(camera.position.z / 16);
  return manager?.biomeAt(ccx, ccz) ?? dimDef?.defaultBiome ?? 'minecraft:plains';
}

function dimensionSkyMode(dimDef: ViewerDimensionDef): 'normal' | 'nether' | 'end' {
  if (dimDef?.sky === 'nether' || dimDef?.sky === 'end') return dimDef.sky;
  return 'normal';
}

function skyHexForBiome(dimensionSky: 'normal' | 'nether' | 'end', biome: BiomeMap[string]): number {
  if (dimensionSky === 'normal') return biome.effects.sky_color;
  if (dimensionSky === 'end') return 0x05010a;
  return biome.effects.fog_color;
}

function skyDimFactor(dimensionSky: 'normal' | 'nether' | 'end'): number {
  if (dimensionSky === 'nether') return 0.45;
  if (dimensionSky === 'end') return 0.8;
  return 1;
}

function fogDensity(dimensionSky: 'normal' | 'nether' | 'end'): number {
  if (dimensionSky === 'normal') return 0.0016;
  if (dimensionSky === 'nether') return 0.009;
  // End terrain should recede into the vanilla lavender void, not an opaque
  // overworld-grey volume. The linear render-distance fog still handles the
  // far edge, so only a light environmental component is needed here.
  return 0.0006;
}

function applyFogRange(engine: Engine, topView: boolean, dense: boolean, viewDistance: number, lodDistance: number) {
  const viewBlocks = viewDistance * 16;
  if (topView) {
    engine.shared.fogNear.value = 1e9;
    engine.shared.fogFar.value = 1e9 + 1;
    engine.shared.envFogDensity.value = 0;
    return;
  }
  engine.shared.fogNear.value = dense ? viewBlocks * 0.1 : viewBlocks * 0.6;
  engine.shared.fogFar.value = (viewDistance + lodDistance) * 16 * (dense ? 0.6 : 0.95);
}

function applyLightingAndFog(
  engine: Engine,
  manager: ChunkManager | null,
  props: ViewerOptions,
  dimDef: ViewerDimensionDef,
  topView: boolean,
  skyColor: THREE.Color,
  horizonColor: THREE.Color,
) {
  const camera = engine.activeCamera;
  const dayFactor = dayFactorForDimension(dimDef, props.timeOfDay);
  const dense = dimDef?.sky === 'nether';

  engine.shared.skyDarken.value = dimDef?.hasSkyLight ? 0.05 + 0.95 * dayFactor : 0;
  engine.shared.ambient.value = dimDef?.ambientLight ?? 0.18;
  applyFogRange(engine, topView, dense, props.viewDistance, props.lodDistance);

  const biomeName = resolveBiomeName(manager, dimDef, camera);
  const biome = engine.biomes[biomeName] ?? engine.biomes['default'];
  if (!biome) return;

  const dimensionSky = dimensionSkyMode(dimDef);
  // The End's biome JSON historically carries a generic fog colour. Vanilla
  // supplies its own lavender End fog instead.
  const fog = dimensionSky === 'end' ? hexToRgb(0xa080a0) : hexToRgb(biome.effects.fog_color);
  const sky = hexToRgb(skyHexForBiome(dimensionSky, biome));
  const bright = 0.15 + 0.85 * (dimDef?.hasSkyLight ? dayFactor : 1);
  const skyDim = skyDimFactor(dimensionSky);

  skyColor.setRGB(sky[0] * bright * skyDim, sky[1] * bright * skyDim, sky[2] * bright * skyDim);
  (engine.scene.background as THREE.Color).lerp(skyColor, 0.05);

  const fogBright = dimensionSky === 'normal' ? bright : 1;
  horizonColor
    .setRGB(fog[0] * fogBright, fog[1] * fogBright, fog[2] * fogBright)
    .lerp(skyColor, dimensionSky === 'normal' ? 0.3 : 0.1);

  engine.shared.fogColor.value.copy(horizonColor).lerp(engine.scene.background as THREE.Color, dense ? 0.15 : 0.45);
  engine.shared.envFogColor.value
    .copy(engine.shared.fogColor.value)
    .lerp(
      engine.scene.background as THREE.Color,
      dimensionSky === 'normal' ? 0.35 : dimensionSky === 'end' ? 0.3 : 0.1,
    );
  if (!topView) engine.shared.envFogDensity.value = fogDensity(dimensionSky);

  updateSkyObjects(
    engine.sky,
    camera,
    props.timeOfDay,
    dayFactor,
    !topView && props.viewMode === 'perspective' && dimensionSky === 'normal',
    skyColor,
    horizonColor,
  );
}

function getPersistableView(engine: Engine, camera: THREE.Camera, viewMode: ViewMode): FlyView {
  const flyView = engine.flyControls.getView();
  return isTopViewMode(viewMode) ? cameraView(camera, flyView.yaw, flyView.pitch) : flyView;
}

function maybeReportStats(
  state: FrameState,
  now: number,
  latestStats: ChunkSchedulerStats,
  camera: THREE.Camera,
  viewMode: ViewMode,
  onStats?: ViewerOptions['onStats'],
) {
  if (now - state.lastStatsReport <= 250) return;
  onStats?.(statsForCamera(latestStats, camera, viewMode));
  state.lastStatsReport = now;
}

function maybePersistActiveView(
  state: FrameState,
  now: number,
  engine: Engine,
  camera: THREE.Camera,
  viewMode: ViewMode,
) {
  if (now - state.lastPersist <= 500) return;
  const updateUrl = now - state.lastUrlPersist > 1500;
  persistView(getPersistableView(engine, camera, viewMode), updateUrl);
  state.lastPersist = now;
  if (updateUrl) state.lastUrlPersist = now;
}

function renderFrame({ engine, manager, latestStats, props, capabilities, state }: FrameContext) {
  const now = performance.now();
  state.timer.update(now);
  const dt = Math.min(state.timer.getDelta(), 0.1);
  engine.shared.animationTime.value = now / 1000;
  state.activeViewMode = syncViewMode(engine, state.activeViewMode, props.viewMode);
  updateActiveControls(engine, props.viewMode, dt);

  const topView = isTopViewMode(props.viewMode);
  const dimDef = updateChunksAndTopMap(engine, manager, props, capabilities, now);
  applyLightingAndFog(engine, manager, props, dimDef, topView, state.skyColor, state.horizonColor);

  const camera = engine.activeCamera;
  engine.overlays.configure(
    props.overlayMapId ?? null,
    props.dimension,
    !!props.overlaysEnabled && !!serviceCapabilities().contentReads,
  );
  engine.overlays.update(engine.renderer, {
    camera,
    topView,
    width: engine.renderer.domElement.clientWidth,
    height: engine.renderer.domElement.clientHeight,
    now,
    dayFactor: dayFactorForDimension(dimDef, props.timeOfDay),
    sky: dimensionSkyMode(dimDef),
    ambient: dimDef.ambientLight,
    surfaceMaxY: props.topClipRange.maxY,
  });
  if (now - state.lastStatsReport > 250) props.onOverlayStatus?.(engine.overlays.diagnosticSnapshot());
  maybeReportStats(state, now, latestStats, camera, props.viewMode, props.onStats);
  maybePersistActiveView(state, now, engine, camera, props.viewMode);
  engine.renderer.render(engine.scene, camera);
}

function createWorldManager(engine: Engine, props: ViewerOptions): ChunkManager {
  const dimDef = dimensionDefinition(engine.dimensions, props.dimension);
  return new ChunkManager(engine.scene, engine.materials, engine.initPayload, {
    world: props.world,
    dimension: props.dimension,
    renderKey: engine.renderKey,
    dimensionDef: dimDef,
    topMapSurfaceYAt: (cx, cz) => engine.topMap.surfaceYAtChunk(cx, cz),
    disableLod: false,
    scheduling: schedulerTuningForPreset(props.schedulerPreset, props.viewDistance, props.lodDistance),
  });
}

function updateFastMoveMultiplier(engine: Engine | null, fastMoveMultiplier: number) {
  engine?.flyControls.setFastMultiplier(fastMoveMultiplier);
  engine?.topPerspectiveControls.setFastMultiplier(fastMoveMultiplier);
  engine?.topOrthographicControls.setFastMultiplier(fastMoveMultiplier);
}

function moveCameraToTarget(engine: Engine, target: CameraPositionRequest, viewMode: ViewMode) {
  if (viewMode === 'topPerspective') {
    engine.topPerspectiveControls.setPosition(target.x, Math.max(TOP_CAMERA_HEIGHT, target.y), target.z);
    engine.activeCamera = engine.topPerspectiveCamera;
  } else if (viewMode === 'topOrthographic') {
    engine.topOrthographicControls.setPosition(target.x, Math.max(TOP_CAMERA_HEIGHT, target.y), target.z);
    engine.activeCamera = engine.topOrthographicCamera;
  } else {
    engine.flyControls.setPosition(target.x, target.y, target.z);
    if (Number.isFinite(target.yaw) || Number.isFinite(target.pitch)) {
      const current = engine.flyControls.getView();
      engine.flyControls.setAngles(
        Number.isFinite(target.yaw) ? target.yaw! : current.yaw,
        Number.isFinite(target.pitch) ? target.pitch! : current.pitch,
      );
    }
    engine.activeCamera = engine.perspectiveCamera;
  }
  setControlsEnabled(engine, viewMode);
}

function updateManagerAfterCameraTarget(engine: Engine, manager: ChunkManager | null, props: ViewerOptions) {
  const topView = isTopViewMode(props.viewMode);
  manager?.update(engine.activeCamera, performance.now(), true, topView, props.topClipRange);
}

/**
 * Owns the canvas, WebGL resources and world lifecycle independently of UI
 * rendering. Call update with current options and dispose when the host is
 * removed. Updates during resource loading apply to the eventual engine;
 * disposed controllers ignore all late resources and capability responses.
 */
export class ViewerController {
  private engine: Engine | null = null;
  private manager: ChunkManager | null = null;
  private latestStats: ChunkSchedulerStats = { ...EMPTY_CHUNK_SCHEDULER_STATS };
  private capabilities: WorldCapabilities | null = null;
  private capabilityGeneration = 0;
  private capabilityRequest: AbortController | null = null;
  private disposed = false;
  private readonly resourceRequest = new AbortController();
  private onResize: (() => void) | null = null;
  private frameState: FrameState | null = null;

  constructor(
    private readonly container: HTMLElement,
    private props: ViewerOptions,
    private readonly onError: (message: string) => void,
    private readonly onReady?: () => void,
  ) {
    this.loadCapabilities(props.world);
    this.registerDiagnostics(props.onDiagnosticSnapshotProvider);
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      THREE.ColorManagement.enabled = false;
      const resources = await loadViewerResources(this.resourceRequest.signal);
      if (this.disposed) return;
      const props = this.props;
      const engine = createEngine(
        this.container,
        resources,
        readInitialView(location.search, readStored(browserStorage('localStorage'), VIEW_STORAGE_KEY)),
        props.viewMode,
        props.fastMoveMultiplier,
        props.inertiaEnabled,
      );
      this.engine = engine;
      this.onResize = createResizeHandler(engine, this.container);
      window.addEventListener('resize', this.onResize);
      const state = createFrameState(props.viewMode);
      state.timer.connect(document);
      this.frameState = state;
      this.syncEngine(null);
      engine.renderer.setAnimationLoop(() =>
        renderFrame({
          engine,
          manager: this.manager,
          latestStats: this.latestStats,
          props: this.props,
          capabilities: this.capabilities,
          state,
        }),
      );
      this.onReady?.();
    } catch (error) {
      this.resourceRequest.abort();
      if (!this.disposed) this.onError(error instanceof Error ? error.message : String(error));
    }
  }

  private loadCapabilities(world: string): void {
    this.capabilityRequest?.abort();
    this.capabilityRequest = null;
    const generation = ++this.capabilityGeneration;
    this.capabilities = null;
    if (!world) return;
    const controller = new AbortController();
    this.capabilityRequest = controller;
    void fetchWorldCapabilities(world, controller.signal)
      .then((value) => {
        if (!this.disposed && generation === this.capabilityGeneration) this.capabilities = value;
      })
      .catch(() => {});
  }

  private registerDiagnostics(register: ViewerOptions['onDiagnosticSnapshotProvider']): void {
    register?.(() =>
      this.engine
        ? diagnosticSnapshotForViewer(
            this.engine,
            this.manager,
            this.latestStats,
            this.props.viewMode,
            this.props.schedulerPreset,
          )
        : null,
    );
  }

  /** Update live options without recreating the renderer or animation loop. */
  update(props: ViewerOptions): void {
    if (this.disposed) return;
    const previous = this.props;
    this.props = props;
    if (previous.world !== props.world) this.loadCapabilities(props.world);
    if (previous.onDiagnosticSnapshotProvider !== props.onDiagnosticSnapshotProvider) {
      previous.onDiagnosticSnapshotProvider?.(null);
      this.registerDiagnostics(props.onDiagnosticSnapshotProvider);
    }
    this.syncEngine(previous);
  }

  private syncEngine(previous: ViewerOptions | null): void {
    const engine = this.engine;
    if (!engine) return;
    const props = this.props;
    const contextChanged = !previous || previous.world !== props.world || previous.dimension !== props.dimension;
    if (contextChanged) {
      this.manager?.dispose();
      this.manager = null;
      this.latestStats = { ...EMPTY_CHUNK_SCHEDULER_STATS };
      if (props.world) {
        const manager = createWorldManager(engine, props);
        manager.onStats = (stats) => {
          this.latestStats = stats;
          this.props.onStats?.(statsForCamera(stats, engine.activeCamera, this.props.viewMode));
        };
        this.manager = manager;
      }
    }
    if (!previous || previous.fastMoveMultiplier !== props.fastMoveMultiplier)
      updateFastMoveMultiplier(engine, props.fastMoveMultiplier);
    if (!previous || previous.inertiaEnabled !== props.inertiaEnabled)
      engine.flyControls.setInertiaEnabled(props.inertiaEnabled);
    if (
      contextChanged ||
      previous?.schedulerPreset !== props.schedulerPreset ||
      previous?.viewDistance !== props.viewDistance ||
      previous?.lodDistance !== props.lodDistance
    ) {
      this.manager?.setScheduling(
        schedulerTuningForPreset(props.schedulerPreset, props.viewDistance, props.lodDistance),
      );
      this.manager?.update(
        engine.activeCamera,
        performance.now(),
        true,
        isTopViewMode(props.viewMode),
        props.topClipRange,
      );
    }
    const target = props.cameraTarget;
    if (target && (!previous || target.seq !== previous.cameraTarget?.seq)) {
      moveCameraToTarget(engine, target, props.viewMode);
      persistView(getPersistableView(engine, engine.activeCamera, props.viewMode), true);
      props.onStats?.(statsForCamera(this.latestStats, engine.activeCamera, props.viewMode));
      updateManagerAfterCameraTarget(engine, this.manager, props);
    }
  }

  /** Idempotently stop work and release CPU/GPU ownership before removing the host. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resourceRequest.abort();
    this.capabilityGeneration++;
    this.capabilityRequest?.abort();
    this.capabilityRequest = null;
    this.props.onDiagnosticSnapshotProvider?.(null);
    if (this.onResize) window.removeEventListener('resize', this.onResize);
    this.frameState?.timer.dispose();
    this.manager?.dispose();
    this.manager = null;
    if (this.engine) disposeEngine(this.engine);
    this.engine = null;
  }
}
