import * as THREE from 'three';
import { createMaterials, createSharedUniforms, createTextureAnimationUniforms } from '../src/render/materials';
import { meshSection, type WorldView } from '@violet-map/render/mesher/full';
import { ModelBaker } from '@violet-map/render/model';
import { AIR, type BlockStateRef } from '@violet-map/core/domain';
import type { AssetBundle, BlockInfo, Direction, RenderLayer } from '@violet-map/core/assets';

/** Four actual meshed sections, including a shared boundary through glass and water. */
export function createTransparencyWorld() {
  const group = new THREE.Group();
  const owned: { dispose(): void }[] = [];
  const shared = createSharedUniforms();
  shared.ambient.value = 1;
  shared.skyDarken.value = 1;
  shared.fogNear.value = 10000;
  shared.fogFar.value = 20000;
  const atlas = new THREE.DataTexture(
    new Uint8Array([180, 180, 180, 255, 255, 40, 40, 128, 40, 80, 255, 128, 40, 130, 255, 120]),
    4,
    1,
  );
  atlas.needsUpdate = true;
  atlas.magFilter = THREE.NearestFilter;
  atlas.minFilter = THREE.NearestFilter;
  const animation = createTextureAnimationUniforms({
    ids: {},
    info: new Uint8Array(4),
    frames: new Uint8Array(4),
    infoSize: [1, 1],
    frameSize: [1, 1],
  });
  const materials = createMaterials(atlas, shared, animation);
  owned.push(atlas, animation.info, animation.frames, ...materials.all);
  const names = ['stone', 'red_glass', 'blue_glass', 'water'];
  const bundle: AssetBundle = { blockstates: {}, models: {} };
  const slots: Record<string, { u0: number; v0: number; u1: number; v1: number }> = {};
  const infos: Record<string, BlockInfo> = {};
  names.forEach((name, index) => {
    const id = `test:${name}`;
    bundle.blockstates[id] = { variants: { '': { model: id } } };
    bundle.models[id] = {
      textures: { all: id },
      elements: [
        {
          from: [0, 0, 0],
          to: [16, 16, 16],
          faces: Object.fromEntries(
            (['down', 'up', 'north', 'south', 'west', 'east'] as Direction[]).map((dir) => [
              dir,
              { texture: '#all', cullface: dir },
            ]),
          ),
        },
      ],
    };
    slots[id] = { u0: index / 4, v0: 0, u1: (index + 1) / 4, v1: 1 };
    infos[id] = {
      layer: index === 0 ? 'opaque' : 'translucent',
      occludes: index === 0,
      cullSameBlock: true,
      emit: 0,
      filter: 0,
      tint: 'none',
      ...(name === 'water' ? { fluid: { texture: id, tint: 'none' } } : {}),
    };
  });
  const blocks = new Map<string, BlockStateRef>();
  const put = (x: number, y: number, z: number, name: string) =>
    blocks.set(`${x},${y},${z}`, { name: `test:${name}`, properties: name === 'water' ? { level: '0' } : {} });
  for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) put(x, 0, z, 'stone');
  for (let x = 4; x < 28; x++)
    for (let y = 1; y < 10; y++) {
      put(x, y, 9, 'red_glass');
      put(x, y, 17, 'blue_glass');
    }
  for (let x = 10; x < 23; x++) for (let z = 10; z < 23; z++) for (let y = 1; y < 4; y++) put(x, y, z, 'water');
  const view: WorldView = {
    getBlock: (x, y, z) => blocks.get(`${x},${y},${z}`) ?? AIR,
    getBiome: () => 'minecraft:plains',
    getSkyLight: () => 15,
    getBlockLight: () => 0,
  };
  const resources = {
    baker: new ModelBaker(bundle),
    info: (name: string) =>
      infos[name] ?? { occludes: false, emit: 0, filter: 0, layer: 'cutout' as const, tint: 'none' as const },
    atlas: slots,
    tint: () => [1, 1, 1] as [number, number, number],
    textureHasAlpha: Object.fromEntries(names.map((name, i) => [`test:${name}`, i !== 0])),
  };
  let triangles = 0;
  for (let cx = 0; cx < 2; cx++)
    for (let cz = 0; cz < 2; cz++) {
      const section = meshSection(
        resources,
        view,
        cx,
        0,
        cz,
        false,
        cx === 0 && cz === 0
          ? [{ model: 'test:blue_glass', x: 14, y: 5, z: 14, layer: 'translucent', scale: [4, 4, 0.2], rotationY: 45 }]
          : [],
      );
      for (const [layer, mesh] of Object.entries(section.layers)) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3, true));
        if (mesh.uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2, !mesh.atlasRects));
        if (mesh.atlasRects) geometry.setAttribute('atlasRect', new THREE.BufferAttribute(mesh.atlasRects, 4, true));
        geometry.setAttribute('tintColor', new THREE.BufferAttribute(mesh.colors, 3, true));
        geometry.setAttribute('lightData', new THREE.BufferAttribute(mesh.lights, 2, true));
        geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
        const object = new THREE.Mesh(geometry, materials[layer as RenderLayer]);
        object.position.set(cx * 16, 0, cz * 16);
        object.frustumCulled = false;
        group.add(object);
        owned.push(geometry);
        triangles += mesh.indices.length / 3;
      }
    }
  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(20, 9),
    new THREE.MeshBasicMaterial({ color: 0x20ff60, opacity: 0.35, transparent: true, side: THREE.DoubleSide }),
  );
  wall.position.set(16, 5, 16);
  wall.rotation.y = Math.PI / 4;
  group.add(wall);
  owned.push(wall.geometry, wall.material);
  return {
    group,
    blocks: blocks.size,
    chunks: 4,
    triangles,
    dispose() {
      for (const resource of owned) resource.dispose();
      group.clear();
    },
  };
}
