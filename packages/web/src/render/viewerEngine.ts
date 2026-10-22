import { readViewerCapabilities } from '../runtime/capabilities';
import { resolveViewerResourceBudget, type ViewerResourceBudget } from '../scheduling/resourceBudget';
import { ChunkScene } from './chunkScene';
import type { TopClipRange } from '../view/worldGeometry';
import { captureView } from './viewSnapshot';
import { TOP_MAP_MAX_RADIUS_BLOCKS } from '../scheduling/topMapPolicy';
import { schedulerTuningForPreset, type SchedulerPreset } from '../scheduling/profiles';
import { type WorldCapabilities } from '@violet-map/core/contracts';
import type { BiomeMap, DimensionMap } from '@violet-map/core/domain';
import { ResourceError } from '@violet-map/core/resources';
import { hexToRgb } from '@violet-map/render';
import * as THREE from 'three';
import { fetchWorldCapabilities } from '../api';
import type { BuiltAtlas } from '../atlas';
import { loadViewerResources, type ViewerResources } from '../runtime/viewerResources';
import { SkyScene, type SkyDiagnosticSnapshot } from './skyScene';
import { browserStorage, readStored } from '../browserStorage';
import { resourceClient } from '../resources/client';
import { serviceCapabilities } from '../runtime';
import type { WorkerInit } from '../worker/protocol';
import {
  buildViewUrl,
  lookAtTargetFromParams,
  readInitialView,
  VIEW_STORAGE_KEY,
  type InitialView,
} from './cameraState';
import { ChunkRuntime, type ChunkRuntimeDiagnosticSnapshot } from '../runtime/chunkRuntime';
import { EMPTY_CHUNK_SCHEDULER_STATS, type ChunkSchedulerStats } from '../diagnostics/contracts';
import { clampFlyPitch, FlyControls, normalizeFlyYaw, TopDownControls, type FlyView } from './controls';
import {
  createMaterials,
  createSharedUniforms,
  createTextureAnimationUniforms,
  type SharedUniforms,
  type TerrainMaterials,
  type TextureAnimationUniforms,
} from './materials';
import { OverlayScene } from './overlayScene';
import { OverlayRuntime, overlayTransport } from '../runtime/overlayRuntime';
import { createOverlayMediaLoader } from '../runtime/overlayMediaLoader';
import { decodeOverlayMedia } from './overlayMedia';
import type { OverlayDiagnosticSnapshot } from '../diagnostics/overlay';
import { TopMapScene } from './topMapScene';
import { TopMapRuntime, type TopMapDiagnosticSnapshot } from '../runtime/topMapRuntime';
import { TransparencyRenderer, type TransparencyDiagnosticSnapshot } from './transparency';

const TOP_CAMERA_HEIGHT = 1024;
const TOP_ORTHO_HEIGHT = 512;
const TOP_PERSPECTIVE_FOV = 50;
const LONG_RANGE_CAMERA_FAR = TOP_MAP_MAX_RADIUS_BLOCKS + 2 * 512;
const DEFAULT_DIMENSION_DEF = {
  hasSkyLight: true,
  ambientLight: 0.18,
  sky: 'normal' as const,
  defaultBiome: 'minecraft:plains',
};
const cameraDirection = new THREE.Vector3();

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
  schema: 2;
  capturedAt: string;
  browser: {
    userAgent: string;
    language: string;
    devicePixelRatio: number;
  };
  camera: ViewerStatsPayload;
  schedulerPreset: SchedulerPreset;
  chunkRuntime: ChunkRuntimeDiagnosticSnapshot | null;
  topMap: TopMapDiagnosticSnapshot;
  overlays: OverlayDiagnosticSnapshot;
  transparency: TransparencyDiagnosticSnapshot;
  sky: SkyDiagnosticSnapshot;
}

type ActiveCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

type ViewerDimensionDef = DimensionMap[string] | typeof DEFAULT_DIMENSION_DEF;

interface Engine {
  budget: ViewerResourceBudget;
  renderer: THREE.WebGLRenderer;
  transparency: TransparencyRenderer;
  scene: THREE.Scene;
  perspectiveCamera: THREE.PerspectiveCamera;
  topPerspectiveCamera: THREE.PerspectiveCamera;
  topOrthographicCamera: THREE.OrthographicCamera;
  activeCamera: ActiveCamera;
  flyControls: FlyControls;
  topPerspectiveControls: TopDownControls;
  topOrthographicControls: TopDownControls;
  topMap: TopMapRuntime;
  overlays: OverlayRuntime;
  overlayScene: OverlayScene;
  materials: TerrainMaterials;
  terrainTexture: THREE.Texture;
  textureAnimations: TextureAnimationUniforms;
  shared: SharedUniforms;
  sky: SkyScene;
  renderKey: string;
  initPayload: Omit<WorkerInit, 'type'>;
  biomes: BiomeMap;
  dimensions: DimensionMap;
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
  chunks: ChunkRuntime | null;
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
  chunks: ChunkRuntime | null,
  stats: ChunkSchedulerStats,
  viewMode: ViewMode,
  schedulerPreset: SchedulerPreset,
): ViewerDiagnosticSnapshot {
  return {
    schema: 2,
    capturedAt: new Date().toISOString(),
    browser: {
      userAgent: navigator.userAgent,
      language: navigator.language,
      devicePixelRatio: window.devicePixelRatio,
    },
    camera: statsForCamera(stats, engine.activeCamera, viewMode),
    schedulerPreset,
    chunkRuntime: chunks?.diagnosticSnapshot() ?? null,
    topMap: engine.topMap.diagnosticSnapshot(),
    overlays: engine.overlays.diagnosticSnapshot(),
    transparency: engine.transparency.diagnosticSnapshot(),
    sky: engine.sky.diagnosticSnapshot(),
  };
}

function topMapAvailable(capabilities: WorldCapabilities | null, dimension: string): boolean {
  return capabilities?.dimensions[dimension]?.hasTopMap === true;
}

function dimensionDefinition(dimensions: DimensionMap, dimension: string): ViewerDimensionDef {
  return dimensions[dimension] ?? DEFAULT_DIMENSION_DEF;
}

function createTerrainTexture(atlas: BuiltAtlas, renderer: THREE.WebGLRenderer): THREE.Texture {
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
  // The scene root is fixed. Dynamic descendants still update normally; static
  // chunk subtrees no longer inherit a forced world-matrix rewrite each frame.
  scene.matrixAutoUpdate = false;
  scene.updateMatrix();
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
  let transparency: TransparencyRenderer;
  try {
    transparency = new TransparencyRenderer(renderer);
  } catch (error) {
    renderer.dispose();
    renderer.domElement.remove();
    throw error;
  }
  const scene = createScene();
  const skyObjects = new SkyScene(scene, resources.sky);
  const cameras = createCameras(container, initialView);
  const terrainTexture = createTerrainTexture(resources.atlas, renderer);
  const shared = createSharedUniforms();
  const textureAnimations = createTextureAnimationUniforms(resources.atlas.animations);
  const materials = createMaterials(terrainTexture, shared, textureAnimations);
  const controls = createControls(renderer.domElement, cameras, initialView, fastMoveMultiplier, inertiaEnabled);
  const budget = resolveViewerResourceBudget(readViewerCapabilities());
  const overlayScene = new OverlayScene(scene, shared, createOverlayMediaLoader(decodeOverlayMedia));
  const topMap = new TopMapRuntime(new TopMapScene(scene, shared), budget.topMapResidentTiles);

  const engine: Engine = {
    budget,
    renderer,
    transparency,
    scene,
    perspectiveCamera: cameras.perspectiveCamera,
    topPerspectiveCamera: cameras.topPerspectiveCamera,
    topOrthographicCamera: cameras.topOrthographicCamera,
    activeCamera: cameras.perspectiveCamera,
    flyControls: controls.flyControls,
    topPerspectiveControls: controls.topPerspectiveControls,
    topOrthographicControls: controls.topOrthographicControls,
    topMap,
    overlays: new OverlayRuntime(overlayScene, overlayTransport),
    overlayScene,
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
  engine.transparency.dispose();
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
  chunks: ChunkRuntime | null,
  props: ViewerOptions,
  capabilities: WorldCapabilities | null,
  now: number,
): ViewerDimensionDef {
  const topView = isTopViewMode(props.viewMode);
  const dimDef = dimensionDefinition(engine.dimensions, props.dimension);
  const offlineTopMap = topMapAvailable(capabilities, props.dimension);

  engine.topMap.configure(props.world, props.dimension, offlineTopMap);
  const view = captureView(engine.activeCamera, topView, props.topClipRange);
  chunks?.update(view, now);
  engine.topMap.update(view, now, chunks ? chunks.displayedChunkKeys() : new Set());

  return dimDef;
}

function dayFactorForDimension(dimDef: ViewerDimensionDef, timeOfDay: number): number {
  if (!dimDef?.hasSkyLight) return 0;
  return clamp01(Math.cos(timeOfDay * Math.PI * 2) * 2 + 0.5);
}

function resolveBiomeName(chunks: ChunkRuntime | null, dimDef: ViewerDimensionDef, camera: THREE.Camera): string {
  const ccx = Math.floor(camera.position.x / 16);
  const ccz = Math.floor(camera.position.z / 16);
  return chunks?.biomeAt(ccx, ccz) ?? dimDef?.defaultBiome ?? 'minecraft:plains';
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
  chunks: ChunkRuntime | null,
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

  const biomeName = resolveBiomeName(chunks, dimDef, camera);
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

  engine.sky.update(
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

function renderFrame({ engine, chunks, latestStats, props, capabilities, state }: FrameContext) {
  const now = performance.now();
  state.timer.update(now);
  const dt = Math.min(state.timer.getDelta(), 0.1);
  engine.shared.animationTime.value = now / 1000;
  state.activeViewMode = syncViewMode(engine, state.activeViewMode, props.viewMode);
  updateActiveControls(engine, props.viewMode, dt);

  const topView = isTopViewMode(props.viewMode);
  const dimDef = updateChunksAndTopMap(engine, chunks, props, capabilities, now);
  applyLightingAndFog(engine, chunks, props, dimDef, topView, state.skyColor, state.horizonColor);

  const camera = engine.activeCamera;
  engine.overlays.configure(
    props.overlayMapId ?? null,
    props.dimension,
    !!props.overlaysEnabled && !!serviceCapabilities().delivery.families.includes('overlay-media'),
  );
  engine.overlays.tick(now);
  engine.overlayScene.render(engine.renderer, {
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
  engine.transparency.render(engine.scene, camera);
}

function createChunkRuntime(engine: Engine, props: ViewerOptions): ChunkRuntime {
  const dimDef = dimensionDefinition(engine.dimensions, props.dimension);
  return new ChunkRuntime(
    new ChunkScene(engine.scene, engine.materials),
    engine.initPayload,
    {
      renderRoot: resourceClient.current(props.world)!.renderRoot,
      world: props.world,
      sourceScope: resourceClient.current(props.world)!.sourceScope,
      dimension: props.dimension,
      renderKey: engine.renderKey,
      dimensionDef: dimDef,
      topMapSurfaceYAt: (cx, cz) => engine.topMap.surfaceYAtChunk(cx, cz),
      disableLod: false,
      scheduling: schedulerTuningForPreset(props.schedulerPreset, props.viewDistance, props.lodDistance),
    },
    engine.budget,
  );
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

function updateRuntimeAfterCameraTarget(engine: Engine, chunks: ChunkRuntime | null, props: ViewerOptions) {
  const topView = isTopViewMode(props.viewMode);
  chunks?.update(captureView(engine.activeCamera, topView, props.topClipRange), performance.now(), true);
}

/**
 * Owns the canvas, WebGL resources and world lifecycle independently of UI
 * rendering. Call update with current options and dispose when the host is
 * removed. Updates during resource loading apply to the eventual engine;
 * disposed controllers ignore all late resources and capability responses.
 */
export class ViewerController {
  private engine: Engine | null = null;
  private chunks: ChunkRuntime | null = null;
  private latestStats: ChunkSchedulerStats = { ...EMPTY_CHUNK_SCHEDULER_STATS };
  private capabilities: WorldCapabilities | null = null;
  private worldRequest: AbortController | null = null;
  private disposed = false;
  private resourceRequest = new AbortController();
  private resourceGeneration = 0;
  private readonly unsubscribe: () => void;
  private onResize: (() => void) | null = null;
  private frameState: FrameState | null = null;

  constructor(
    private readonly container: HTMLElement,
    private props: ViewerOptions,
    private readonly onError: (message: string) => void,
    private readonly onReady?: () => void,
  ) {
    this.unsubscribe = resourceClient.subscribe((previous, current) => {
      if (current.renderRoot !== previous.renderRoot) {
        this.resourceRequest.abort();
        this.resourceRequest = new AbortController();
        void this.initialize();
      } else if (current.sourceScope !== previous.sourceScope && resourceClient.current(this.props.world) === current) {
        this.syncEngine(null);
      } else {
        void this.chunks?.refreshResources().catch((error) => this.onError(String(error)));
        void this.engine?.overlays.refresh();
      }
    });
    this.loadWorldMetadata(props.world);
    this.registerDiagnostics(props.onDiagnosticSnapshotProvider);
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    const generation = ++this.resourceGeneration;
    const controller = this.resourceRequest;
    try {
      THREE.ColorManagement.enabled = false;
      const resources = await loadViewerResources(controller.signal);
      for (;;) {
        const world = this.props.world;
        if (!world) break;
        const lifetime = this.worldRequest;
        if (!lifetime) throw new Error('selected world has no metadata lifetime');
        try {
          const head = await resourceClient.head(world, false, AbortSignal.any([controller.signal, lifetime.signal]));
          if (world !== this.props.world) continue;
          if (head.renderRoot !== resourceClient.current()?.renderRoot)
            throw new ResourceError(
              'RESOURCE_VIEW_EXPIRED',
              'world and render resources belong to different roots',
              true,
            );
          resourceClient.assertCurrent(head, world);
          break;
        } catch (error) {
          if (!controller.signal.aborted && world !== this.props.world) continue;
          throw error;
        }
      }
      if (this.disposed || generation !== this.resourceGeneration) return;
      const props = this.props;
      const engine = createEngine(
        this.container,
        resources,
        readInitialView(location.search, readStored(browserStorage('localStorage'), VIEW_STORAGE_KEY)),
        props.viewMode,
        props.fastMoveMultiplier,
        props.inertiaEnabled,
      );
      if (this.engine) {
        this.chunks?.dispose();
        this.chunks = null;
        this.frameState?.timer.dispose();
        if (this.onResize) window.removeEventListener('resize', this.onResize);
        disposeEngine(this.engine);
      }
      this.engine = engine;
      this.onResize = createResizeHandler(engine, this.container);
      window.addEventListener('resize', this.onResize);
      const state = createFrameState(props.viewMode);
      state.timer.connect(document);
      this.frameState = state;
      this.syncEngine(null);
      engine.renderer.setAnimationLoop(() => {
        try {
          renderFrame({
            engine,
            chunks: this.chunks,
            latestStats: this.latestStats,
            props: this.props,
            capabilities: this.capabilities,
            state,
          });
        } catch (error) {
          engine.renderer.setAnimationLoop(null);
          if (!this.disposed) this.onError(error instanceof Error ? error.message : String(error));
        }
      });
      this.onReady?.();
    } catch (error) {
      if (this.disposed || generation !== this.resourceGeneration) return;
      controller.abort();
      if (!this.disposed) this.onError(error instanceof Error ? error.message : String(error));
    }
  }

  private loadWorldMetadata(world: string): void {
    this.worldRequest?.abort();
    this.worldRequest = null;
    this.capabilities = null;
    if (!world) return;
    const controller = new AbortController();
    this.worldRequest = controller;
    void fetchWorldCapabilities(world, controller.signal)
      .then((value) => {
        if (!this.disposed && this.worldRequest === controller) this.capabilities = value;
      })
      .catch(() => {});
  }

  private registerDiagnostics(register: ViewerOptions['onDiagnosticSnapshotProvider']): void {
    register?.(() =>
      this.engine
        ? diagnosticSnapshotForViewer(
            this.engine,
            this.chunks,
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
    if (previous.world !== props.world) this.loadWorldMetadata(props.world);
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
      this.chunks?.dispose();
      this.chunks = null;
      this.latestStats = { ...EMPTY_CHUNK_SCHEDULER_STATS };
    }
    if (props.world && !resourceClient.current(props.world)) {
      void resourceClient.head(props.world, false, this.worldRequest?.signal).then(
        () => {
          if (!this.disposed && this.props.world === props.world) this.syncEngine(null);
        },
        (error) => {
          if (!this.disposed && this.props.world === props.world) this.onError(String(error));
        },
      );
      return;
    }
    if (contextChanged) {
      if (props.world) {
        const chunks = createChunkRuntime(engine, props);
        chunks.onStats = (stats) => {
          this.latestStats = stats;
          this.props.onStats?.(statsForCamera(stats, engine.activeCamera, this.props.viewMode));
        };
        this.chunks = chunks;
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
      this.chunks?.setScheduling(
        schedulerTuningForPreset(props.schedulerPreset, props.viewDistance, props.lodDistance),
      );
      this.chunks?.update(
        captureView(engine.activeCamera, isTopViewMode(props.viewMode), props.topClipRange),
        performance.now(),
        true,
      );
    }
    const target = props.cameraTarget;
    if (target && (!previous || target.seq !== previous.cameraTarget?.seq)) {
      moveCameraToTarget(engine, target, props.viewMode);
      persistView(getPersistableView(engine, engine.activeCamera, props.viewMode), true);
      props.onStats?.(statsForCamera(this.latestStats, engine.activeCamera, props.viewMode));
      updateRuntimeAfterCameraTarget(engine, this.chunks, props);
    }
  }

  /** Idempotently stop work and release CPU/GPU ownership before removing the host. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.resourceGeneration++;
    this.resourceRequest.abort();
    this.worldRequest?.abort();
    this.worldRequest = null;
    this.props.onDiagnosticSnapshotProvider?.(null);
    if (this.onResize) window.removeEventListener('resize', this.onResize);
    this.frameState?.timer.dispose();
    this.chunks?.dispose();
    this.chunks = null;
    if (this.engine) disposeEngine(this.engine);
    this.engine = null;
  }
}
