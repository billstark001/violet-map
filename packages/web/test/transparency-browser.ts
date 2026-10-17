import * as THREE from 'three';
import { TransparencyRenderer } from '../src/render/transparency';
import { createTransparencyWorld } from './transparency-world';
import { transparencyGlb } from './transparency-glb';

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
    const before = image();
    scene.children.reverse();
    scene.children.forEach((object, index) => {
      object.renderOrder = index * -7;
    });
    scene.traverse((object) => {
      object.children.reverse();
      if (!(object instanceof THREE.Mesh) || !object.geometry.index) return;
      const index = object.geometry.index;
      const original = index.array.slice();
      for (let i = 0; i < index.count; i += 3) {
        const source = index.count - 3 - i;
        for (let j = 0; j < 3; j++) index.array[i + j] = original[source + j];
      }
      index.needsUpdate = true;
    });
    const after = image();
    let maxDifference = 0,
      changed = 0;
    for (let i = 0; i < before.length; i++) {
      const difference = Math.abs(before[i] - after[i]);
      maxDifference = Math.max(maxDifference, difference);
      if (difference > 1) changed++;
    }
    return { maxDifference, changed };
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
