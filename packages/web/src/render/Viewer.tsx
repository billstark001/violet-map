import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useTranslation } from 'react-i18next';
import type { BiomeMap, DimensionMap } from '@violet-map/core';
import { hexToRgb } from '@violet-map/core';
import {
  fetchBiomes,
  fetchBlockInfo,
  fetchBundle,
  fetchDimensions,
  fetchWorldCapabilities,
  textureUrl,
  type WorldCapabilities,
} from '../api';
import { buildAtlas, collectTextureIds, loadColormap } from '../atlas';
import { ChunkManager, type TopClipRange } from './chunkManager';
import { EMPTY_CHUNK_SCHEDULER_STATS, type ChunkSchedulerStats } from './chunkScheduler';
import { FlyControls, TopDownControls, type FlyView } from './controls';
import { createMaterials, createSharedUniforms, SharedUniforms, TerrainMaterials } from './materials';
import { TopMapManager } from './topMapManager';
import type { WorkerInit } from '../worker/protocol';

const VIEW_STORAGE_KEY = 'violet-map:view';
const MESH_CACHE_SCHEMA = 'mesh-v7-neighborhood-resident';
const SKY_PLANE_FORWARD = new THREE.Vector3(0, 0, 1);
const TOP_CAMERA_HEIGHT = 1024;
const TOP_ORTHO_HEIGHT = 512;
const TOP_PERSPECTIVE_FOV = 50;
const DEFAULT_VIEW: FlyView = { x: 8, y: 120, z: 8, yaw: 0, pitch: 0 };
const DEFAULT_DIMENSION_DEF = {
  hasSkyLight: true,
  ambientLight: 0.18,
  sky: 'normal' as const,
  defaultBiome: 'minecraft:plains',
};
const celestialFacing = new THREE.Vector3();
const cameraDirection = new THREE.Vector3();

export type ViewMode = 'perspective' | 'topPerspective' | 'topOrthographic';

export interface CameraPositionRequest {
  x: number;
  y: number;
  z: number;
  seq: number;
}

export interface ViewerProps {
  world: string;
  dimension: string;
  viewDistance: number;
  lodDistance: number;
  fastMoveMultiplier: number;
  inertiaEnabled: boolean;
  viewMode: ViewMode;
  topClipRange: TopClipRange;
  timeOfDay: number; // 0=正午, 0.5=午夜
  cameraTarget?: CameraPositionRequest;
  onStats?: (s: ViewerStatsPayload) => void;
}

export type ViewerStatsPayload = ChunkSchedulerStats & {
  pos: [number, number, number];
  yaw: number;
  pitch: number;
  viewMode: ViewMode;
};

type ActiveCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera;
type InitialView = FlyView & { hasAngles: boolean };
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
  materials: TerrainMaterials;
  terrainTexture: THREE.Texture;
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
  clock: THREE.Clock;
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
  props: ViewerProps;
  capabilities: WorldCapabilities | null;
  state: FrameState;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function finiteParam(params: URLSearchParams, key: string, fallback: number): number {
  const value = Number(params.get(key));
  return Number.isFinite(value) ? value : fallback;
}

function fixed(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '0';
}

function viewFromParams(params: URLSearchParams, defaults: FlyView = DEFAULT_VIEW): InitialView | null {
  const hasPosition = params.has('x') || params.has('y') || params.has('z');
  const hasAngles = params.has('yaw') || params.has('pitch');
  if (!hasPosition && !hasAngles) return null;
  return {
    x: finiteParam(params, 'x', defaults.x),
    y: finiteParam(params, 'y', defaults.y),
    z: finiteParam(params, 'z', defaults.z),
    yaw: finiteParam(params, 'yaw', defaults.yaw),
    pitch: finiteParam(params, 'pitch', defaults.pitch),
    hasAngles,
  };
}

function parseSavedView(raw: string | null): Partial<FlyView> | null {
  try {
    return JSON.parse(raw ?? 'null') as Partial<FlyView> | null;
  } catch {
    return null;
  }
}

function viewFromSaved(saved: Partial<FlyView> | null, defaults: FlyView = DEFAULT_VIEW): InitialView | null {
  if (!saved) return null;
  return {
    x: finiteNumber(saved.x, defaults.x),
    y: finiteNumber(saved.y, defaults.y),
    z: finiteNumber(saved.z, defaults.z),
    yaw: finiteNumber(saved.yaw, defaults.yaw),
    pitch: finiteNumber(saved.pitch, defaults.pitch),
    hasAngles: Number.isFinite(saved.yaw) || Number.isFinite(saved.pitch),
  };
}

function readInitialView(): InitialView {
  return (
    viewFromParams(new URLSearchParams(location.search))
    ?? viewFromSaved(parseSavedView(localStorage.getItem(VIEW_STORAGE_KEY)))
    ?? { ...DEFAULT_VIEW, hasAngles: false }
  );
}

function buildViewUrl(pathname: string, search: string, hash: string, view: FlyView): string {
  const params = new URLSearchParams(search);
  params.set('x', fixed(view.x, 2));
  params.set('y', fixed(view.y, 2));
  params.set('z', fixed(view.z, 2));
  params.set('yaw', fixed(view.yaw, 4));
  params.set('pitch', fixed(view.pitch, 4));
  params.delete('lookAtX');
  params.delete('lookAtY');
  params.delete('lookAtZ');
  return `${pathname}?${params.toString()}${hash}`;
}

function persistView(view: FlyView, updateUrl: boolean) {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(view));
  } catch {
    // Storage can be unavailable in private or restricted contexts.
  }
  if (!updateUrl) return;
  history.replaceState(null, '', buildViewUrl(location.pathname, location.search, location.hash, view));
}

function lookAtTargetFromParams(
  params: URLSearchParams,
  fallback: THREE.Vector3,
): [number, number, number] | null {
  if (!params.has('lookAtX') && !params.has('lookAtY') && !params.has('lookAtZ')) return null;
  return [
    finiteParam(params, 'lookAtX', fallback.x),
    finiteParam(params, 'lookAtY', fallback.y),
    finiteParam(params, 'lookAtZ', fallback.z - 1),
  ];
}

function cameraView(camera: THREE.Camera, yaw: number, pitch: number): FlyView {
  return {
    x: camera.position.x,
    y: camera.position.y,
    z: camera.position.z,
    yaw,
    pitch,
  };
}

function resizeTopCamera(camera: THREE.OrthographicCamera, width: number, height: number) {
  const aspect = width / Math.max(1, height);
  camera.left = -TOP_ORTHO_HEIGHT * aspect / 2;
  camera.right = TOP_ORTHO_HEIGHT * aspect / 2;
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
    yaw: Math.atan2(-cameraDirection.x, -cameraDirection.z),
    pitch: Math.asin(THREE.MathUtils.clamp(cameraDirection.y, -1, 1)),
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

function topMapAvailable(capabilities: WorldCapabilities | null, dimension: string): boolean {
  return capabilities?.dimensions[dimension]?.hasTopMap === true;
}

function dimensionDefinition(dimensions: DimensionMap, dimension: string): ViewerDimensionDef {
  return dimensions[dimension] ?? DEFAULT_DIMENSION_DEF;
}

function hashString(input: string, seed = 2166136261): number {
  let h = seed;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hashBytes(bytes: Uint8Array | null, seed = 2166136261): number {
  let h = seed;
  if (!bytes) return h >>> 0;
  for (const byte of bytes) {
    h ^= byte;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function buildRenderKey(atlasKey: string, bundle: unknown, blockInfo: unknown, grassMap: Uint8Array | null, foliageMap: Uint8Array | null): string {
  let h = hashString(`${MESH_CACHE_SCHEMA}:${atlasKey}`);
  h = hashString(stableStringify(bundle), h);
  h = hashString(stableStringify(blockInfo), h);
  h = hashBytes(grassMap, h);
  h = hashBytes(foliageMap, h);
  return `${MESH_CACHE_SCHEMA}:${atlasKey}:${h.toString(36)}`;
}

async function loadViewerResources(): Promise<ViewerResources> {
  const [bundle, blockInfo, biomes, dimensions, grassMap, foliageMap] = await Promise.all([
    fetchBundle(),
    fetchBlockInfo(),
    fetchBiomes(),
    fetchDimensions(),
    loadColormap('minecraft:colormap/grass'),
    loadColormap('minecraft:colormap/foliage'),
  ]);
  const atlas = await buildAtlas(collectTextureIds(bundle, blockInfo));
  return {
    bundle,
    blockInfo,
    biomes,
    dimensions,
    grassMap,
    foliageMap,
    atlas,
    renderKey: buildRenderKey(atlas.cacheKey, bundle, blockInfo, grassMap, foliageMap),
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
): THREE.Texture {
  const texture = configurePixelTexture(new THREE.CanvasTexture(fallback));
  const tryLoad = (index: number) => {
    const candidate = candidates[index];
    if (!candidate) return;
    const img = new Image();
    img.onload = () => {
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
    };
    img.onerror = () => tryLoad(index + 1);
    img.src = textureUrl(candidate.id);
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
  const group = new THREE.Group();
  const domeMaterial = createSkyDomeMaterial();
  const domeGeometry = new THREE.SphereGeometry(1200, 32, 16);
  const dome = new THREE.Mesh(domeGeometry, domeMaterial);
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  group.add(dome);

  const sunTexture = loadCanvasBackedTexture(makeCelestialFallback('sun'), [
    { id: 'minecraft:environment/celestial/sun' },
    { id: 'minecraft:environment/sun' },
  ]);
  const moonTexture = loadCanvasBackedTexture(makeCelestialFallback('moon'), [
    { id: 'minecraft:environment/celestial/moon/full_moon' },
    { id: 'minecraft:environment/moon_phases', cropMoonSheet: true },
  ]);
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
  const sunDir = new THREE.Vector3(Math.sin(angle), Math.cos(angle), -0.25).normalize();
  const moonDir = sunDir.clone().multiplyScalar(-1);
  sky.sun.position.copy(sunDir).multiplyScalar(850);
  sky.moon.position.copy(moonDir.multiplyScalar(850));
  sky.sun.quaternion.setFromUnitVectors(SKY_PLANE_FORWARD, celestialFacing.copy(sunDir).negate());
  sky.moon.quaternion.setFromUnitVectors(SKY_PLANE_FORWARD, celestialFacing.copy(moonDir).negate().normalize());
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
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);
  return renderer;
}

function createScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x78a7ff);
  return scene;
}

function createPerspectiveCamera(container: HTMLElement, initialView: InitialView, params: URLSearchParams): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 2000);
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
    6000,
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
  const materials = createMaterials(terrainTexture, shared);
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
    materials,
    terrainTexture,
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
  engine.sky.dispose();
  for (const material of engine.materials.all) material.dispose();
  engine.terrainTexture.dispose();
  engine.renderer.renderLists.dispose();
  engine.renderer.dispose();
  engine.renderer.domElement.remove();
}

function createFrameState(initialViewMode: ViewMode): FrameState {
  return {
    clock: new THREE.Clock(),
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
    const targetControls = nextMode === 'topPerspective'
      ? engine.topPerspectiveControls
      : engine.topOrthographicControls;
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

function visibleRadiusBlocks(viewDistance: number, lodDistance: number): number {
  return Math.max(1024, (viewDistance + lodDistance + 32) * 16);
}

function chunkClipY(topView: boolean, offlineTopMap: boolean): number | undefined {
  return topView && offlineTopMap ? 0 : undefined;
}

function rendererHeight(engine: Engine): number {
  return engine.renderer.domElement.clientHeight || window.innerHeight;
}

function updateChunksAndTopMap(
  engine: Engine,
  manager: ChunkManager | null,
  props: ViewerProps,
  capabilities: WorldCapabilities | null,
  now: number,
): { topView: boolean; dimDef: ViewerDimensionDef; offlineTopMap: boolean } {
  const topView = isTopViewMode(props.viewMode);
  const dimDef = dimensionDefinition(engine.dimensions, props.dimension);
  const offlineTopMap = topMapAvailable(capabilities, props.dimension);

  engine.topMap.configure(props.world, props.dimension, offlineTopMap);
  if (manager) manager.root.visible = true;
  manager?.update(
    engine.activeCamera,
    now,
    false,
    rendererHeight(engine),
    topView,
    props.topClipRange,
    chunkClipY(topView, offlineTopMap),
  );
  engine.topMap.update(engine.activeCamera, now, {
    mode: topView ? 'top' : 'perspective',
    radiusBlocks: visibleRadiusBlocks(props.viewDistance, props.lodDistance),
    onlineChunks: manager?.displayedChunkKeys(),
  });

  return { topView, dimDef, offlineTopMap };
}

function dayFactorForDimension(dimDef: ViewerDimensionDef, timeOfDay: number): number {
  if (!dimDef?.hasSkyLight) return 0;
  return clamp01(Math.cos(timeOfDay * Math.PI * 2) * 2 + 0.5);
}

function resolveBiomeName(
  manager: ChunkManager | null,
  dimDef: ViewerDimensionDef,
  camera: THREE.Camera,
): string {
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
  return 0.0035;
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
  props: ViewerProps,
  dimDef: ViewerDimensionDef,
  topView: boolean,
  skyColor: THREE.Color,
  horizonColor: THREE.Color,
) {
  const camera = engine.activeCamera;
  const dayFactor = dayFactorForDimension(dimDef, props.timeOfDay);
  const dense = dimDef?.sky !== 'normal';

  engine.shared.skyDarken.value = dimDef?.hasSkyLight ? 0.05 + 0.95 * dayFactor : 0;
  engine.shared.ambient.value = dimDef?.ambientLight ?? 0.18;
  applyFogRange(engine, topView, dense, props.viewDistance, props.lodDistance);

  const biomeName = resolveBiomeName(manager, dimDef, camera);
  const biome = engine.biomes[biomeName] ?? engine.biomes['default'];
  if (!biome) return;

  const dimensionSky = dimensionSkyMode(dimDef);
  const fog = hexToRgb(biome.effects.fog_color);
  const sky = hexToRgb(skyHexForBiome(dimensionSky, biome));
  const bright = 0.15 + 0.85 * (dimDef?.hasSkyLight ? dayFactor : 1);
  const skyDim = skyDimFactor(dimensionSky);

  skyColor.setRGB(sky[0] * bright * skyDim, sky[1] * bright * skyDim, sky[2] * bright * skyDim);
  (engine.scene.background as THREE.Color).lerp(skyColor, 0.05);

  const fogBright = dimensionSky === 'normal' ? bright : 1;
  horizonColor
    .setRGB(fog[0] * fogBright, fog[1] * fogBright, fog[2] * fogBright)
    .lerp(skyColor, dimensionSky === 'normal' ? 0.3 : 0.1);

  engine.shared.fogColor.value
    .copy(horizonColor)
    .lerp(engine.scene.background as THREE.Color, dense ? 0.15 : 0.45);
  engine.shared.envFogColor.value
    .copy(engine.shared.fogColor.value)
    .lerp(engine.scene.background as THREE.Color, dimensionSky === 'normal' ? 0.35 : 0.1);
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
  onStats?: ViewerProps['onStats'],
) {
  if (now - state.lastStatsReport <= 250) return;
  onStats?.(statsForCamera(latestStats, camera, viewMode));
  state.lastStatsReport = now;
}

function maybePersistActiveView(state: FrameState, now: number, engine: Engine, camera: THREE.Camera, viewMode: ViewMode) {
  if (now - state.lastPersist <= 500) return;
  const updateUrl = now - state.lastUrlPersist > 1500;
  persistView(getPersistableView(engine, camera, viewMode), updateUrl);
  state.lastPersist = now;
  if (updateUrl) state.lastUrlPersist = now;
}

function renderFrame({ engine, manager, latestStats, props, capabilities, state }: FrameContext) {
  const dt = Math.min(state.clock.getDelta(), 0.1);
  const now = performance.now();
  state.activeViewMode = syncViewMode(engine, state.activeViewMode, props.viewMode);
  updateActiveControls(engine, props.viewMode, dt);

  const { topView, dimDef } = updateChunksAndTopMap(engine, manager, props, capabilities, now);
  applyLightingAndFog(engine, manager, props, dimDef, topView, state.skyColor, state.horizonColor);

  const camera = engine.activeCamera;
  maybeReportStats(state, now, latestStats, camera, props.viewMode, props.onStats);
  maybePersistActiveView(state, now, engine, camera, props.viewMode);
  engine.renderer.render(engine.scene, camera);
}

function createWorldManager(engine: Engine, props: ViewerProps): ChunkManager {
  const dimDef = dimensionDefinition(engine.dimensions, props.dimension);
  return new ChunkManager(engine.scene, engine.materials, engine.initPayload, {
    world: props.world,
    dimension: props.dimension,
    renderKey: engine.renderKey,
    dimensionDef: dimDef,
    viewDistance: props.viewDistance,
    lodDistance: props.lodDistance,
    // 十分抽象，渲染一个lod耗时是渲染完整区块的85%左右，完全没有优化性能的意义，不如直接拔了
    disableLod: true,
    scheduling: {
      previewBias: 0.5,
      refinementBias: 1.8,
      frontLoadBias: 2.2,
      rearEvictBias: 2.2,
      frontKeepBias: 1.3,
      rearKeepBias: 0.35,
      sideKeepBias: 0.75,
      rearQueueRetentionBias: 0.25,
    }
  });
}

function updateRenderDistances(manager: ChunkManager | null, viewDistance: number, lodDistance: number) {
  if (!manager) return;
  manager.opts.viewDistance = viewDistance;
  manager.opts.lodDistance = lodDistance;
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
    engine.activeCamera = engine.perspectiveCamera;
  }
  setControlsEnabled(engine, viewMode);
}

function updateManagerAfterCameraTarget(
  engine: Engine,
  manager: ChunkManager | null,
  props: ViewerProps,
  capabilities: WorldCapabilities | null,
) {
  const topView = isTopViewMode(props.viewMode);
  manager?.update(
    engine.activeCamera,
    performance.now(),
    true,
    rendererHeight(engine),
    topView,
    props.topClipRange,
    chunkClipY(topView, topMapAvailable(capabilities, props.dimension)),
  );
}

export function Viewer(props: ViewerProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const managerRef = useRef<ChunkManager | null>(null);
  const latestStatsRef = useRef<ChunkSchedulerStats>({ ...EMPTY_CHUNK_SCHEDULER_STATS });
  const propsRef = useRef(props);
  propsRef.current = props;
  const capabilitiesRef = useRef<WorldCapabilities | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    capabilitiesRef.current = null;
    if (!props.world) return;
    fetchWorldCapabilities(props.world)
      .then((next) => {
        if (!cancelled) capabilitiesRef.current = next;
      })
      .catch(() => {
        if (!cancelled) capabilitiesRef.current = null;
      });
    return () => {
      cancelled = true;
    };
  }, [props.world]);

  // 一次性初始化：GL、资源、图集、动画循环
  useEffect(() => {
    let disposed = false;
    let onResize: (() => void) | null = null;
    const container = containerRef.current;
    if (!container) return;

    (async () => {
      try {
        THREE.ColorManagement.enabled = false;
        const resources = await loadViewerResources();
        if (disposed) return;

        const engine = createEngine(
          container,
          resources,
          readInitialView(),
          propsRef.current.viewMode,
          propsRef.current.fastMoveMultiplier,
          propsRef.current.inertiaEnabled,
        );
        engineRef.current = engine;

        onResize = createResizeHandler(engine, container);
        window.addEventListener('resize', onResize);

        const frameState = createFrameState(propsRef.current.viewMode);
        engine.renderer.setAnimationLoop(() => {
          renderFrame({
            engine,
            manager: managerRef.current,
            latestStats: latestStatsRef.current,
            props: propsRef.current,
            capabilities: capabilitiesRef.current,
            state: frameState,
          });
        });
        setReady(true);
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      }
    })();

    return () => {
      disposed = true;
      if (onResize) window.removeEventListener('resize', onResize);
      if (engineRef.current) {
        disposeEngine(engineRef.current);
        engineRef.current = null;
      }
    };
  }, []);

  // 世界/维度切换：仅重建 ChunkManager
  useEffect(() => {
    const engine = engineRef.current;
    if (!ready || !engine || !props.world) return;

    const manager = createWorldManager(engine, props);
    manager.onStats = (s) => {
      latestStatsRef.current = s;
      propsRef.current.onStats?.(statsForCamera(s, engine.activeCamera, propsRef.current.viewMode));
    };
    managerRef.current = manager;

    return () => {
      managerRef.current = null;
      manager.dispose();
    };
  }, [ready, props.world, props.dimension]);

  // 渲染距离热更新
  useEffect(() => {
    updateRenderDistances(managerRef.current, props.viewDistance, props.lodDistance);
  }, [props.viewDistance, props.lodDistance]);

  useEffect(() => {
    updateFastMoveMultiplier(engineRef.current, props.fastMoveMultiplier);
  }, [props.fastMoveMultiplier]);

  useEffect(() => {
    engineRef.current?.flyControls.setInertiaEnabled(props.inertiaEnabled);
  }, [props.inertiaEnabled]);

  // 外部手动设置坐标
  useEffect(() => {
    const engine = engineRef.current;
    const target = props.cameraTarget;
    if (!ready || !engine || !target) return;

    moveCameraToTarget(engine, target, props.viewMode);
    persistView(getPersistableView(engine, engine.activeCamera, props.viewMode), true);
    propsRef.current.onStats?.(statsForCamera(latestStatsRef.current, engine.activeCamera, props.viewMode));
    updateManagerAfterCameraTarget(engine, managerRef.current, props, capabilitiesRef.current);
  }, [ready, props.cameraTarget?.seq]);

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0 }}>
      {error && <div style={{ position: 'absolute', top: 8, left: 8, color: '#f66' }}>{t('initFailed', { message: error })}</div>}
    </div>
  );
}
