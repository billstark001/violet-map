import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { BiomeMap, DimensionMap } from '@mcr/core';
import { hexToRgb } from '@mcr/core';
import { fetchBiomes, fetchBlockInfo, fetchBundle, fetchDimensions } from '../api';
import { buildAtlas, collectTextureIds, loadColormap } from '../atlas';
import { ChunkManager } from './chunkManager';
import { FlyControls } from './controls';
import { createMaterials, createSharedUniforms, SharedUniforms, TerrainMaterials } from './materials';
import type { WorkerInit } from '../worker/protocol';

export interface ViewerProps {
  world: string;
  dimension: string;
  viewDistance: number;
  lodDistance: number;
  timeOfDay: number; // 0=正午, 0.5=午夜
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

export function Viewer(props: ViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const managerRef = useRef<ChunkManager | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 一次性初始化：GL、资源、图集
  useEffect(() => {
    let disposed = false;
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
        const params = new URLSearchParams(location.search);
        camera.position.set(Number(params.get('x') ?? 8), Number(params.get('y') ?? 120), Number(params.get('z') ?? 8));

        const texture = new THREE.CanvasTexture(atlas.canvas);
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;

        const shared = createSharedUniforms();
        const materials = createMaterials(texture, shared);
        const controls = new FlyControls(renderer.domElement, camera);

        engineRef.current = {
          renderer, scene, camera, controls, materials, shared, biomes, dimensions,
          initPayload: {
            bundle, blockInfo, biomes,
            atlasIndex: atlas.index, avgColors: atlas.avgColors,
            grassColormap: grassMap, foliageColormap: foliageMap,
          },
        };

        const onResize = () => {
          camera.aspect = container.clientWidth / container.clientHeight;
          camera.updateProjectionMatrix();
          renderer.setSize(container.clientWidth, container.clientHeight);
        };
        window.addEventListener('resize', onResize);

        const skyColor = new THREE.Color();
        const clock = new THREE.Clock();
        let statTimer = 0;
        renderer.setAnimationLoop(() => {
          const dt = Math.min(clock.getDelta(), 0.1);
          const p = propsRef.current;
          controls.update(dt);
          const manager = managerRef.current;
          manager?.update(camera.position, performance.now());

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
          e.shared.ambient.value = dimDef?.ambientLight ?? 0.03;
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

          statTimer += dt;
          if (statTimer > 0.2) {
            statTimer = 0;
            p.onStats?.({
              loaded: 0, rendered: 0,
              pos: [camera.position.x, camera.position.y, camera.position.z],
            });
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
    const dimDef = e.dimensions[props.dimension] ?? { hasSkyLight: true, ambientLight: 0.03, sky: 'normal' as const, defaultBiome: 'minecraft:plains' };
    const manager = new ChunkManager(e.scene, e.materials, e.initPayload, {
      world: props.world,
      dimension: props.dimension,
      dimensionDef: dimDef,
      viewDistance: props.viewDistance,
      lodDistance: props.lodDistance,
    });
    manager.onStats = (s) => propsRef.current.onStats?.({ ...s, pos: [e.camera.position.x, e.camera.position.y, e.camera.position.z] });
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

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0 }}>
      {error && <div style={{ position: 'absolute', top: 8, left: 8, color: '#f66' }}>初始化失败：{error}</div>}
    </div>
  );
}