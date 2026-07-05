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
  initPayload: Omit<WorkerInit, 'type'>;
  biomes: BiomeMap;
  dimensions: DimensionMap;
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
        texture.minFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
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
          renderer, scene, camera, controls, materials, shared, biomes, dimensions,
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
            const skyHex = dimDef?.sky === 'normal' ? biome.effects.sky_color : biome.effects.fog_color;
            const sky = hexToRgb(skyHex);
            const bright = 0.15 + 0.85 * (dimDef?.hasSkyLight ? dayFactor : 1);
            skyColor.setRGB(sky[0] * bright, sky[1] * bright, sky[2] * bright);
            (scene.background as THREE.Color).lerp(skyColor, 0.05);
            e.shared.fogColor.value.setRGB(fog[0] * bright, fog[1] * bright, fog[2] * bright)
              .lerp(scene.background as THREE.Color, dense ? 0 : 0.5);
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
      {error && <div style={{ position: 'absolute', top: 8, left: 8, color: '#f66' }}>初始化失败：{error}</div>}
    </div>
  );
}
