import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { BiomeMap, DimensionMap } from '@violet-map/core';
import { hexToRgb } from '@violet-map/core';
import { fetchBiomes, fetchBlockInfo, fetchBundle, fetchDimensions } from '../api';
import { buildAtlas, collectTextureIds, loadColormap } from '../atlas';
import { ChunkManager } from './chunkManager';
import { FlyControls, type FlyView } from './controls';
import { createMaterials, createSharedUniforms, SharedUniforms, TerrainMaterials } from './materials';
import type { WorkerInit } from '../worker/protocol';

const VIEW_STORAGE_KEY = 'violet-map:view';

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
  initPayload: Omit<WorkerInit, 'type'>;
  biomes: BiomeMap;
  dimensions: DimensionMap;
}

interface SkyObjects {
  group: THREE.Group;
  sun: THREE.Sprite;
  moon: THREE.Sprite;
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

function makeDiscTexture(inner: string, outer: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 96;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(48, 48, 10, 48, 48, 48);
  g.addColorStop(0, inner);
  g.addColorStop(0.42, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 96, 96);
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function createSkyObjects(scene: THREE.Scene): SkyObjects {
  const group = new THREE.Group();
  const sunTexture = makeDiscTexture('rgba(255,245,190,1)', 'rgba(255,210,120,0)');
  const moonTexture = makeDiscTexture('rgba(210,225,255,0.95)', 'rgba(120,150,220,0)');
  const sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTexture, transparent: true, depthWrite: false }));
  const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: moonTexture, transparent: true, depthWrite: false }));
  sun.scale.set(90, 90, 1);
  moon.scale.set(70, 70, 1);
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
    const z = rand() * 2 - 1;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    positions[i * 3] = Math.cos(a) * r * 900;
    positions[i * 3 + 1] = Math.max(0.08, z) * 900;
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
    sun,
    moon,
    stars,
    dispose() {
      scene.remove(group);
      sunTexture.dispose();
      moonTexture.dispose();
      sun.material.dispose();
      moon.material.dispose();
      starGeometry.dispose();
      starMaterial.dispose();
    },
  };
}

function updateSkyObjects(sky: SkyObjects, camera: THREE.Camera, timeOfDay: number, dayFactor: number, visible: boolean) {
  sky.group.position.copy(camera.position);
  sky.group.visible = visible;
  if (!visible) return;
  const angle = timeOfDay * Math.PI * 2;
  const sunDir = new THREE.Vector3(Math.sin(angle), Math.cos(angle), -0.25).normalize();
  const moonDir = sunDir.clone().multiplyScalar(-1);
  sky.sun.position.copy(sunDir.multiplyScalar(850));
  sky.moon.position.copy(moonDir.multiplyScalar(850));
  const night = Math.min(1, Math.max(0, (0.55 - dayFactor) / 0.55));
  (sky.sun.material as THREE.SpriteMaterial).opacity = Math.min(1, Math.max(0, dayFactor * 1.2));
  (sky.moon.material as THREE.SpriteMaterial).opacity = night * 0.8;
  (sky.stars.material as THREE.PointsMaterial).opacity = night * 0.85;
}

export function Viewer(props: ViewerProps) {
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
            e.shared.fogColor.value.setRGB(fog[0] * fogBright, fog[1] * fogBright, fog[2] * fogBright)
              .lerp(scene.background as THREE.Color, dense ? 0.15 : 0.45);
            e.shared.envFogColor.value.copy(e.shared.fogColor.value).lerp(scene.background as THREE.Color, dimensionSky === 'normal' ? 0.35 : 0.1);
            e.shared.envFogDensity.value = dimensionSky === 'normal' ? 0.0016 : dimensionSky === 'nether' ? 0.009 : 0.0035;
            updateSkyObjects(e.sky, camera, t, dayFactor, dimensionSky === 'normal');
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
    managerRef.current?.update(e.camera.position, performance.now());
  }, [ready, props.cameraTarget?.seq]);

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0 }}>
      {error && <div style={{ position: 'absolute', top: 8, left: 8, color: '#f66' }}>Initialization failed: {error}</div>}
    </div>
  );
}
