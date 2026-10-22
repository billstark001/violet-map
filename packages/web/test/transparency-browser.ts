import * as THREE from 'three';
import { TransparencyRenderer } from '../src/render/transparency';
import { createTransparencyWorld } from './transparency-world';
import { transparencyGlb } from './transparency-glb';
import { TopMapScene } from '../src/render/topMapScene';
import { StaticMesh } from '../src/render/staticMesh';
import { createSharedUniforms } from '../src/render/materials';
import type { PreparedTopMapTile, TopMapTilePayload } from '@violet-map/core/formats/top-map';

THREE.ColorManagement.enabled = false;

const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });

renderer.setPixelRatio(1);

renderer.setSize(640, 480);

document.body.appendChild(renderer.domElement);

const transparency = new TransparencyRenderer(renderer);
const scene = new THREE.Scene();

scene.background = new THREE.Color(0);

const orthographic = new THREE.OrthographicCamera(-4, 4, 3, -3, 0.1, 2000);
const perspective = new THREE.PerspectiveCamera(45, 4 / 3, 0.1, 2000);
let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = orthographic;
const owned: { dispose(): void }[] = [];

function clear() {
  scene.clear();
  for (const resource of owned.splice(0)) resource.dispose();
}

function plane(color: number, opacity: number, z: number, tilt = 0, type = 'basic') {
  const geometry = new THREE.PlaneGeometry(5, 4);
  const material =
    type === 'standard'
      ? new THREE.MeshStandardMaterial({ color, opacity, transparent: true, side: THREE.DoubleSide })
      : new THREE.MeshBasicMaterial({ color, opacity, transparent: opacity < 1, side: THREE.DoubleSide });
  const object = new THREE.Mesh(geometry, material);
  object.position.z = z;
  object.rotation.y = tilt;
  owned.push(geometry, material);
  scene.add(object);
  return object;
}

function draw() {
  transparency.render(scene, camera);
}

function pixel(x = 320, y = 240) {
  const gl = renderer.getContext();
  const data = new Uint8Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
  return [...data];
}

function image() {
  draw();
  const gl = renderer.getContext();
  const data = new Uint8Array(renderer.domElement.width * renderer.domElement.height * 4);
  gl.readPixels(0, 0, renderer.domElement.width, renderer.domElement.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
  return data;
}

const harness = {
  setup(kind: 'single' | 'layers' | 'crossing' | 'occluded' | 'foreground' | 'standard', projection = 'orthographic') {
    clear();
    renderer.setSize(640, 480);
    orthographic.left = -4;
    orthographic.right = 4;
    orthographic.top = 3;
    orthographic.bottom = -3;
    orthographic.updateProjectionMatrix();
    camera = projection === 'perspective' ? perspective : orthographic;
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    if (kind === 'single') plane(0xff0000, 0.5, 1);
    if (kind === 'layers' || kind === 'occluded' || kind === 'foreground') {
      plane(0xff0000, 0.5, 1);
      plane(0x0000ff, 0.5, -1);
    }
    if (kind === 'crossing') {
      plane(0xff0000, 0.5, 0, 0.7);
      plane(0x0000ff, 0.5, 0, -0.7);
    }
    if (kind === 'occluded') plane(0x00ff00, 1, 2);
    if (kind === 'foreground') {
      const front = plane(0x00ff00, 0.5, -2);
      front.material.depthTest = false;
      front.material.depthWrite = false;
    }
    if (kind === 'standard') {
      scene.add(new THREE.AmbientLight(0xffffff, 3));
      plane(0xff0000, 0.5, 1, 0, 'standard');
    }
    draw();
    return { center: pixel(), left: pixel(220), right: pixel(420), status: transparency.diagnosticSnapshot() };
  },
  world(projection = 'perspective') {
    clear();
    renderer.setSize(960, 720);
    camera = projection === 'perspective' ? perspective : orthographic;
    orthographic.left = -24;
    orthographic.right = 24;
    orthographic.top = 18;
    orthographic.bottom = -18;
    camera.updateProjectionMatrix();
    camera.position.set(42, 28, 44);
    camera.lookAt(16, 3, 16);
    const world = createTransparencyWorld();
    scene.add(world.group);
    owned.push(world);
    draw();
    return {
      blocks: world.blocks,
      chunks: world.chunks,
      triangles: world.triangles,
      status: transparency.diagnosticSnapshot(),
    };
  },
  reorder() {
    const submitted: number[] = [];
    const callbacks = new Map<THREE.Mesh, THREE.Mesh['onBeforeRender']>();
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const previous = object.onBeforeRender;
      callbacks.set(object, previous);
      object.onBeforeRender = (...args) => {
        submitted.push(object.id);
        previous.apply(object, args);
      };
    });
    const before = image();
    const beforeOrder = submitted.splice(0);
    let drawOrder = 0;
    scene.traverse((object) => {
      object.children.reverse();
      if (!(object instanceof THREE.Mesh)) return;
      object.renderOrder = ++drawOrder * 7;
      if (!object.geometry.index) return;
      const index = object.geometry.index;
      const original = index.array.slice();
      for (let i = 0; i < index.count; i += 3) {
        const source = index.count - 3 - i;
        for (let j = 0; j < 3; j++) index.array[i + j] = original[source + j];
      }
      index.needsUpdate = true;
    });
    const after = image();
    for (const [object, callback] of callbacks) object.onBeforeRender = callback;
    let maxDifference = 0,
      changed = 0;
    for (let i = 0; i < before.length; i++) {
      const difference = Math.abs(before[i] - after[i]);
      maxDifference = Math.max(maxDifference, difference);
      if (difference > 1) changed++;
    }
    return { maxDifference, changed, beforeOrder, afterOrder: submitted };
  },
  benchmark(frames = 60) {
    const values = [];
    for (let i = 0; i < frames; i++) {
      const start = performance.now();
      draw();
      values.push(performance.now() - start);
    }
    values.sort((a, b) => a - b);
    const gl = renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      cpuMedianMs: values[Math.floor(frames / 2)],
      cpuP95Ms: values[Math.floor(frames * 0.95)],
      gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      status: transparency.diagnosticSnapshot(),
    };
  },
  staticCulling() {
    clear();
    renderer.setSize(640, 480);
    camera = orthographic;
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    orthographic.left = -4;
    orthographic.right = 4;
    orthographic.top = 3;
    orthographic.bottom = -3;
    camera.updateProjectionMatrix();
    const geometry = new THREE.PlaneGeometry(0.6, 0.6);
    const material = new THREE.MeshBasicMaterial({ color: 0x00ff00, opacity: 0.5, transparent: true });
    owned.push(geometry, material);
    const make = (stable: boolean) => {
      const group = new THREE.Group();
      group.position.x = 0.2;
      group.rotation.z = 0.05;
      const objects = Array.from({ length: 2000 }, (_, i) => {
        const mesh = stable ? new StaticMesh(geometry, material) : new THREE.Mesh(geometry, material);
        mesh.position.set(i < 8 ? (i % 4) - 1.5 : 100 + i, i < 8 ? Math.floor(i / 4) - 0.5 : 0, 0);
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        group.add(mesh);
        return mesh;
      });
      return { group, objects };
    };
    const general = make(false),
      stable = make(true);
    let intersections = 0;
    const intersect = THREE.Frustum.prototype.intersectsObject;
    THREE.Frustum.prototype.intersectsObject = function (object) {
      if (object instanceof THREE.Mesh && object.geometry === geometry) intersections++;
      return intersect.call(this, object);
    };
    const compare = () => {
      scene.clear();
      scene.add(general.group);
      intersections = 0;
      const reference = image();
      const generalIntersections = intersections;
      scene.clear();
      scene.add(stable.group);
      intersections = 0;
      const actual = image();
      const stableIntersections = intersections;
      let difference = 0;
      for (let i = 0; i < reference.length; i++) difference = Math.max(difference, Math.abs(reference[i] - actual[i]));
      return { difference, generalIntersections, stableIntersections };
    };
    try {
      const original = compare();
      const rounds = [];
      for (let round = 0; round < 3; round++) {
        const measures: Record<string, number> = {};
        for (const [name, fixture] of round % 2
          ? ([
              ['stable', stable],
              ['general', general],
            ] as const)
          : ([
              ['general', general],
              ['stable', stable],
            ] as const)) {
          scene.clear();
          scene.add(fixture.group);
          for (let i = 0; i < 5; i++) draw();
          measures[name] = harness.benchmark(40).cpuMedianMs;
        }
        rounds.push(measures);
      }
      for (const fixture of [general, stable]) {
        fixture.objects[8].position.set(0, 0, 0);
        fixture.objects[8].updateMatrix();
        fixture.group.position.x = -0.4;
      }
      const moved = compare();
      const object = stable.objects[8];
      const source = object.material;
      object.onBeforeRender = () => {
        throw new Error('static render failure');
      };
      let failure = '';
      try {
        draw();
      } catch (error) {
        failure = String(error);
      }
      object.onBeforeRender = () => {};
      const restored =
        stable.objects.every((mesh) => mesh.frustumCulled && mesh.parent === stable.group) &&
        object.material === source;
      const recovered = compare();
      scene.clear();
      const parent = new StaticMesh(geometry, material);
      const child = new StaticMesh(geometry, material);
      parent.position.x = 100;
      child.position.x = -100;
      parent.add(child);
      scene.add(parent);
      draw();
      const nested = pixel();
      parent.layers.set(1);
      draw();
      const layered = pixel();
      return {
        original,
        moved,
        recovered,
        failure,
        restored,
        rounds,
        nested,
        layered,
        hierarchyRestored: parent.parent === scene && child.parent === parent && parent.children[0] === child,
      };
    } finally {
      THREE.Frustum.prototype.intersectsObject = intersect;
    }
  },
  memory() {
    return {
      ...renderer.info.memory,
      programs: renderer.info.programs?.length,
      status: transparency.diagnosticSnapshot(),
    };
  },
  edges() {
    clear();
    renderer.setSize(640, 480);
    camera = perspective;
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    plane(0xff0000, 0, 3);
    const solid = plane(0x00ff00, 1, 1);
    solid.material.transparent = true;
    plane(0x0000ff, 0.5, -1);
    draw();
    const opaque = pixel();
    solid.material.visible = false;
    draw();
    const hidden = pixel();
    solid.material.visible = true;
    solid.material.opacity = 0.5;
    solid.material.color.setRGB(1, 0, 0);
    draw();
    return { opaque, hidden, dynamic: pixel() };
  },
  textured() {
    clear();
    const texture = new THREE.DataTexture(new Uint8Array([255, 0, 0, 0, 255, 0, 0, 128]), 2, 1);
    texture.needsUpdate = true;
    texture.magFilter = THREE.NearestFilter;
    const object = plane(0xffffff, 0.5, 1);
    object.material.opacity = 1;
    object.material.map = texture;
    owned.push(texture);
    draw();
    const alpha = { left: pixel(220), right: pixel(420) };
    object.material.transparent = false;
    object.material.alphaTest = 0.5;
    object.material.color.setRGB(0, 1, 0);
    const pixels = texture.image.data as Uint8Array;
    pixels.set([255, 255, 255, 0, 255, 255, 255, 255]);
    texture.needsUpdate = true;
    plane(0x0000ff, 0.5, -1);
    draw();
    return { alpha, cutout: { left: pixel(220), right: pixel(420) } };
  },
  coveredRange() {
    clear();
    camera = perspective;
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    plane(0xff0000, 0.5, 2);
    const opaque = plane(0x00ff00, 1, 1);
    opaque.material.transparent = true;
    plane(0x0000ff, 0.5, -1000);
    draw();
    return pixel();
  },
  async glb() {
    clear();
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().parseAsync(transparencyGlb(), '');
    scene.add(gltf.scene, new THREE.AmbientLight(0xffffff, 3));
    let blended = 0;
    gltf.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      owned.push(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        owned.push(material);
        if (material.transparent && material instanceof THREE.MeshStandardMaterial) blended++;
      }
    });
    draw();
    return { blended, center: pixel(), status: transparency.diagnosticSnapshot() };
  },
  reference() {
    clear();
    const object = plane(0x336699, 1, 1);
    renderer.render(scene, camera);
    const original = pixel();
    draw();
    const result = pixel();
    const originalMaterial = object.material;
    const background = scene.background;
    originalMaterial.onBeforeRender = () => {
      throw new Error('expected material failure');
    };
    let failure = '';
    try {
      draw();
    } catch (error) {
      failure = String(error);
    }
    const restored =
      object.material === originalMaterial &&
      scene.background === background &&
      renderer.autoClear &&
      renderer.info.autoReset &&
      renderer.getRenderTarget() === null;
    originalMaterial.onBeforeRender = () => {};
    return { original, result, failure, restored };
  },
  resize(width: number, height: number) {
    renderer.setSize(width, height);
    draw();
    return transparency.diagnosticSnapshot();
  },
  pointSize() {
    clear();
    renderer.setSize(3840, 2160);
    camera = perspective;
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    const material = new THREE.PointsMaterial({ color: 0xffffff, size: 64, sizeAttenuation: false });
    const points = new THREE.Points(geometry, material);
    points.userData.oitBackground = true;
    scene.add(points);
    owned.push(geometry, material);
    const measure = () => {
      const gl = renderer.getContext();
      const row = new Uint8Array(256 * 4);
      gl.readPixels(1920 - 128, 1080, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
      let width = 0;
      for (let x = 0; x < 256; x++) if (row[x * 4] > 128) width++;
      return width;
    };
    const results = [];
    for (const attenuated of [false, true]) {
      material.sizeAttenuation = attenuated;
      material.size = attenuated ? 0.6 : 64;
      material.needsUpdate = true;
      renderer.render(scene, camera);
      const reference = measure();
      draw();
      results.push({ attenuated, reference, actual: measure() });
    }
    return results;
  },
  nestedOwnership() {
    clear();
    renderer.setSize(640, 480);
    camera = orthographic;
    orthographic.left = -4;
    orthographic.right = 4;
    orthographic.top = 3;
    orthographic.bottom = -3;
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    const parent = plane(0x0000ff, 1, 0);
    const child = plane(0xff0000, 0.5, 1);
    const light = new THREE.AmbientLight(0xffffff);
    parent.add(light);
    light.add(child);
    const parentChildren = parent.children;
    const lightChildren = light.children;
    draw();
    const center = pixel();
    let failure = '';
    parent.material.onBeforeRender = () => {
      throw new Error('nested render failure');
    };
    try {
      draw();
    } catch (error) {
      failure = String(error);
    }
    parent.material.onBeforeRender = () => {};
    return {
      center,
      failure,
      restored:
        parent.parent === scene &&
        light.parent === parent &&
        child.parent === light &&
        parent.children === parentChildren &&
        light.children === lightChildren &&
        camera.matrixWorldAutoUpdate,
    };
  },
  async contextRecovery() {
    clear();
    renderer.setSize(640, 480);
    plane(0x00ff00, 1, 0);
    draw();
    const before = pixel();
    const extension = renderer.getContext().getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('context-loss injection is unavailable');
    const lost = new Promise<void>((resolve) =>
      renderer.domElement.addEventListener('webglcontextlost', () => resolve(), { once: true }),
    );
    extension.loseContext();
    await lost;
    draw();
    const lostStatus = transparency.diagnosticSnapshot().contextLost;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const restored = new Promise<void>((resolve) =>
      renderer.domElement.addEventListener('webglcontextrestored', () => resolve(), { once: true }),
    );
    extension.restoreContext();
    await restored;
    draw();
    return { before, after: pixel(), lostStatus, restoredStatus: transparency.diagnosticSnapshot().contextLost };
  },
  topMapOwnership() {
    clear();
    renderer.setSize(640, 480);
    const view = new THREE.OrthographicCamera(-40, 40, 30, -30, 0.1, 200);
    view.position.set(32, 90, 32);
    view.up.set(0, 0, -1);
    view.lookAt(32, 10, 32);
    renderer.render(scene, view);
    const before = { ...renderer.info.memory };
    const colors = new Uint8Array(64 * 64 * 4);
    for (let offset = 0; offset < colors.length; offset += 4) colors.set([32, 224, 64, 255], offset);
    const data: PreparedTopMapTile = {
      payload: {
        size: { blocks: 64, samples: 64, colorSamples: 64, lightSamples: 64 },
        origin: { x: 0, z: 0 },
        sampleStride: 1,
        colorStride: 1,
        lightStride: 1,
        minY: 0,
        approach: 'top',
      } as TopMapTilePayload,
      heights: new Int16Array(64 * 64).fill(10),
      colors,
      lights: new Uint8Array(64 * 64 * 2).fill(15),
    };
    const cycles = [];
    for (let cycle = 0; cycle < 5; cycle++) {
      const display = new TopMapScene(scene, createSharedUniforms());
      display.setEnabled(true);
      display.add('tile', data);
      const frames = [];
      for (const step of [8, 4, 2, 8]) {
        display.update('tile', step, '', undefined);
        renderer.render(scene, view);
        frames.push({ step, center: pixel(), memory: { ...renderer.info.memory } });
      }
      display.setWanted(new Set());
      renderer.render(scene, view);
      const hidden = pixel();
      display.setWanted(new Set(['tile']));
      renderer.render(scene, view);
      const restored = pixel();
      display.remove('tile');
      display.dispose();
      display.dispose();
      renderer.render(scene, view);
      cycles.push({ frames, hidden, restored, after: { ...renderer.info.memory } });
    }
    return { before, cycles };
  },
  dispose() {
    clear();
    transparency.dispose();
    return { ...renderer.info.memory };
  },
};

declare global {
  interface Window {
    transparencyHarness: typeof harness;
  }
}

window.transparencyHarness = harness;
