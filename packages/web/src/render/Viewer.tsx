import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { useTranslation } from 'react-i18next';
import type { BiomeMap, DimensionMap } from '@violet-map/core';
import { hexToRgb } from '@violet-map/core';
import { fetchBiomes, fetchBlockInfo, fetchBundle, fetchDimensions, textureUrl } from '../api';
import { buildAtlas, collectTextureIds, loadColormap } from '../atlas';
import { ChunkManager } from './chunkManager';
import { FlyControls, type FlyView } from './controls';
import { createMaterials, createSharedUniforms, SharedUniforms, TerrainMaterials } from './materials';
import type { WorkerInit } from '../worker/protocol';

const VIEW_STORAGE_KEY = 'violet-map:view';
const MESH_CACHE_SCHEMA = 'mesh-v3-neighborhood-lod';
const SKY_PLANE_FORWARD = new THREE.Vector3(0, 0, 1);
const celestialFacing = new THREE.Vector3();

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
  timeOfDay: number; // 0=正午, 0.5=午夜
  cameraTarget?: CameraPositionRequest;
  onStats?: (s: { loaded: number; rendered: number; pos: [number, number, number] }) => void;
}

interface Engine {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: FlyControls;
  materials: TerrainMaterials;
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

function finiteParam(params: URLSearchParams, key: string, fallback: number): number {
  const value = Number(params.get(key));
  return Number.isFinite(value) ? value : fallback;
}

function readInitialView(): FlyView & { hasAngles: boolean } {
  const defaults = { x: 8, y: 120, z: 8, yaw: 0, pitch: 0 };
  const params = new URLSearchParams(location.search);
  const hasPosition = params.has('x') || params.has('y') || params.has('z');
  const hasAngles = params.has('yaw') || params.has('pitch');
  if (hasPosition || hasAngles) {
    return {
      x: finiteParam(params, 'x', defaults.x),
      y: finiteParam(params, 'y', defaults.y),
      z: finiteParam(params, 'z', defaults.z),
      yaw: finiteParam(params, 'yaw', defaults.yaw),
      pitch: finiteParam(params, 'pitch', defaults.pitch),
      hasAngles,
    };
  }
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_STORAGE_KEY) ?? 'null') as Partial<FlyView> | null;
    if (saved) {
      return {
        x: Number.isFinite(saved.x) ? saved.x! : defaults.x,
        y: Number.isFinite(saved.y) ? saved.y! : defaults.y,
        z: Number.isFinite(saved.z) ? saved.z! : defaults.z,
        yaw: Number.isFinite(saved.yaw) ? saved.yaw! : defaults.yaw,
        pitch: Number.isFinite(saved.pitch) ? saved.pitch! : defaults.pitch,
        hasAngles: Number.isFinite(saved.yaw) || Number.isFinite(saved.pitch),
      };
    }
  } catch {
    // Ignore malformed local state.
  }
  return { ...defaults, hasAngles: false };
}

function fixed(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '0';
}

function persistView(view: FlyView, updateUrl: boolean) {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(view));
  } catch {
    // Storage can be unavailable in private or restricted contexts.
  }
  if (!updateUrl) return;
  const params = new URLSearchParams(location.search);
  params.set('x', fixed(view.x, 2));
  params.set('y', fixed(view.y, 2));
  params.set('z', fixed(view.z, 2));
  params.set('yaw', fixed(view.yaw, 4));
  params.set('pitch', fixed(view.pitch, 4));
  params.delete('lookAtX');
  params.delete('lookAtY');
  params.delete('lookAtZ');
  history.replaceState(null, '', `${location.pathname}?${params.toString()}${location.hash}`);
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

function configurePixelTexture(texture: THREE.Texture): THREE.Texture {
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace;
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
  const night = Math.min(1, Math.max(0, (0.55 - dayFactor) / 0.55));
  const sunset = Math.max(0, 1 - Math.abs(sunDir.y) / 0.34) * Math.min(1, dayFactor * 1.6);
  sky.domeMaterial.uniforms.topColor.value.copy(topColor);
  sky.domeMaterial.uniforms.horizonColor.value.copy(horizonColor);
  sky.domeMaterial.uniforms.sunDir.value.copy(sunDir);
  sky.domeMaterial.uniforms.sunsetAmount.value = sunset;
  sky.domeMaterial.uniforms.nightAmount.value = night;
  sky.sun.material.opacity = Math.min(1, Math.max(0, dayFactor * 1.2));
  sky.moon.material.opacity = night * 0.8;
  (sky.stars.material as THREE.PointsMaterial).opacity = night * 0.85;
}

export function Viewer(props: ViewerProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const managerRef = useRef<ChunkManager | null>(null);
  const latestStatsRef = useRef({ loaded: 0, rendered: 0 });
  const propsRef = useRef(props);
  propsRef.current = props;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 一次性初始化：GL、资源、图集
  useEffect(() => {
    let disposed = false;
    let onResize: (() => void) | null = null;
    const container = containerRef.current!;
    (async () => {
      try {
        THREE.ColorManagement.enabled = false;
        const [bundle, blockInfo, biomes, dimensions, grassMap, foliageMap] = await Promise.all([
          fetchBundle(), fetchBlockInfo(), fetchBiomes(), fetchDimensions(),
          loadColormap('minecraft:colormap/grass'), loadColormap('minecraft:colormap/foliage'),
        ]);
        const atlas = await buildAtlas(collectTextureIds(bundle, blockInfo));
        if (disposed) return;
        const renderKey = buildRenderKey(atlas.cacheKey, bundle, blockInfo, grassMap, foliageMap);

        const renderer = new THREE.WebGLRenderer({ antialias: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(container.clientWidth, container.clientHeight);
        container.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x78a7ff);
        const skyObjects = createSkyObjects(scene);
        const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 2000);
        const initialView = readInitialView();
        const params = new URLSearchParams(location.search);
        camera.rotation.order = 'YXZ';
        camera.position.set(initialView.x, initialView.y, initialView.z);
        if (!initialView.hasAngles && (params.has('lookAtX') || params.has('lookAtY') || params.has('lookAtZ'))) {
          camera.lookAt(
            Number(params.get('lookAtX') ?? camera.position.x),
            Number(params.get('lookAtY') ?? camera.position.y),
            Number(params.get('lookAtZ') ?? camera.position.z - 1),
          );
        }

        const texture = new THREE.CanvasTexture(atlas.canvas);
        texture.flipY = false;
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.generateMipmaps = true;
        texture.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.needsUpdate = true;

        const shared = createSharedUniforms();
        const materials = createMaterials(texture, shared);
        const controls = new FlyControls(
          renderer.domElement,
          camera,
          initialView.hasAngles ? { yaw: initialView.yaw, pitch: initialView.pitch } : undefined,
        );

        engineRef.current = {
          renderer, scene, camera, controls, materials, shared, sky: skyObjects, biomes, dimensions,
          renderKey,
          initPayload: {
            bundle, blockInfo, biomes,
            atlasIndex: atlas.index, avgColors: atlas.avgColors,
            textureHasAlpha: atlas.hasAlpha,
            grassColormap: grassMap, foliageColormap: foliageMap,
          },
        };

        onResize = () => {
          camera.aspect = container.clientWidth / container.clientHeight;
          camera.updateProjectionMatrix();
          renderer.setSize(container.clientWidth, container.clientHeight);
        };
        window.addEventListener('resize', onResize);

        const skyColor = new THREE.Color();
        const horizonColor = new THREE.Color();
        const clock = new THREE.Clock();
        let lastStatsReport = 0;
        let lastPersist = 0;
        let lastUrlPersist = 0;
        renderer.setAnimationLoop(() => {
          const dt = Math.min(clock.getDelta(), 0.1);
          const now = performance.now();
          const p = propsRef.current;
          controls.update(dt);
          const manager = managerRef.current;
          manager?.update(camera.position, now);

          // 天空/雾：数据驱动（群系 + 维度）
          const e = engineRef.current!;
          const dimDef = e.dimensions[p.dimension];
          const ccx = Math.floor(camera.position.x / 16), ccz = Math.floor(camera.position.z / 16);
          const biomeName = manager?.biomeAt(ccx, ccz) ?? dimDef?.defaultBiome ?? 'minecraft:plains';
          const biome = e.biomes[biomeName] ?? e.biomes['default'];
          const t = p.timeOfDay;
          const dayFactor = dimDef?.hasSkyLight
            ? Math.min(Math.max(Math.cos(t * Math.PI * 2) * 2 + 0.5, 0), 1)
            : 0;
          e.shared.skyDarken.value = dimDef?.hasSkyLight ? 0.05 + 0.95 * dayFactor : 0;
          e.shared.ambient.value = dimDef?.ambientLight ?? 0.18;
          const viewBlocks = p.viewDistance * 16;
          const dense = dimDef?.sky !== 'normal';
          e.shared.fogNear.value = dense ? viewBlocks * 0.1 : viewBlocks * 0.6;
          e.shared.fogFar.value = (p.viewDistance + p.lodDistance) * 16 * (dense ? 0.6 : 0.95);
          if (biome) {
            const fog = hexToRgb(biome.effects.fog_color);
            const dimensionSky = dimDef?.sky ?? 'normal';
            const skyHex = dimensionSky === 'normal'
              ? biome.effects.sky_color
              : dimensionSky === 'end'
                ? 0x05010a
                : biome.effects.fog_color;
            const sky = hexToRgb(skyHex);
            const bright = 0.15 + 0.85 * (dimDef?.hasSkyLight ? dayFactor : 1);
            const skyDim = dimensionSky === 'nether' ? 0.45 : dimensionSky === 'end' ? 0.8 : 1;
            skyColor.setRGB(sky[0] * bright * skyDim, sky[1] * bright * skyDim, sky[2] * bright * skyDim);
            (scene.background as THREE.Color).lerp(skyColor, 0.05);
            const fogBright = dimensionSky === 'normal' ? bright : 1;
            horizonColor.setRGB(fog[0] * fogBright, fog[1] * fogBright, fog[2] * fogBright)
              .lerp(skyColor, dimensionSky === 'normal' ? 0.3 : 0.1);
            e.shared.fogColor.value.copy(horizonColor)
              .lerp(scene.background as THREE.Color, dense ? 0.15 : 0.45);
            e.shared.envFogColor.value.copy(e.shared.fogColor.value).lerp(scene.background as THREE.Color, dimensionSky === 'normal' ? 0.35 : 0.1);
            e.shared.envFogDensity.value = dimensionSky === 'normal' ? 0.0016 : dimensionSky === 'nether' ? 0.009 : 0.0035;
            updateSkyObjects(e.sky, camera, t, dayFactor, dimensionSky === 'normal', skyColor, horizonColor);
          }

          if (now - lastStatsReport > 250) {
            const s = latestStatsRef.current;
            propsRef.current.onStats?.({ ...s, pos: [camera.position.x, camera.position.y, camera.position.z] });
            lastStatsReport = now;
          }
          if (now - lastPersist > 500) {
            const updateUrl = now - lastUrlPersist > 1500;
            persistView(controls.getView(), updateUrl);
            lastPersist = now;
            if (updateUrl) lastUrlPersist = now;
          }

          renderer.render(scene, camera);
        });
        setReady(true);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
    return () => {
      disposed = true;
      const e = engineRef.current;
      if (onResize) window.removeEventListener('resize', onResize);
      if (e) {
        e.renderer.setAnimationLoop(null);
        e.controls.dispose();
        e.sky.dispose();
        e.renderer.dispose();
        e.renderer.domElement.remove();
        engineRef.current = null;
      }
    };
  }, []);

  // 世界/维度切换：仅重建 ChunkManager
  useEffect(() => {
    const e = engineRef.current;
    if (!ready || !e || !props.world) return;
    const dimDef = e.dimensions[props.dimension] ?? { hasSkyLight: true, ambientLight: 0.18, sky: 'normal' as const, defaultBiome: 'minecraft:plains' };
    const manager = new ChunkManager(e.scene, e.materials, e.initPayload, {
      world: props.world,
      dimension: props.dimension,
      renderKey: e.renderKey,
      dimensionDef: dimDef,
      viewDistance: props.viewDistance,
      lodDistance: props.lodDistance,
    });
    manager.onStats = (s) => {
      latestStatsRef.current = s;
      propsRef.current.onStats?.({ ...s, pos: [e.camera.position.x, e.camera.position.y, e.camera.position.z] });
    };
    managerRef.current = manager;
    return () => {
      managerRef.current = null;
      manager.dispose();
    };
  }, [ready, props.world, props.dimension]);

  // 渲染距离热更新
  useEffect(() => {
    const m = managerRef.current;
    if (m) {
      m.opts.viewDistance = props.viewDistance;
      m.opts.lodDistance = props.lodDistance;
    }
  }, [props.viewDistance, props.lodDistance]);

  useEffect(() => {
    engineRef.current?.controls.setFastMultiplier(props.fastMoveMultiplier);
  }, [props.fastMoveMultiplier]);

  // 外部手动设置坐标
  useEffect(() => {
    const e = engineRef.current;
    const target = props.cameraTarget;
    if (!ready || !e || !target) return;
    e.controls.setPosition(target.x, target.y, target.z);
    persistView(e.controls.getView(), true);
    const s = latestStatsRef.current;
    propsRef.current.onStats?.({ ...s, pos: [e.camera.position.x, e.camera.position.y, e.camera.position.z] });
    managerRef.current?.update(e.camera.position, performance.now(), true);
  }, [ready, props.cameraTarget?.seq]);

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0 }}>
      {error && <div style={{ position: 'absolute', top: 8, left: 8, color: '#f66' }}>{t('initFailed', { message: error })}</div>}
    </div>
  );
}
