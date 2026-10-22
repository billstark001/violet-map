import * as THREE from 'three';
import { StaticMesh } from './staticMesh';
import {
  OIT_ATTACHMENT_COUNT,
  OIT_BIN_COUNT,
  OIT_BYTES_PER_PIXEL,
  OIT_COMPOSITE_FRAGMENT,
  OIT_FULLSCREEN_VERTEX,
  oitBufferSize,
  patchOitFragment,
  type OitPhase,
} from './oitShaders';

type Drawable = THREE.Object3D & { material: THREE.Material | THREE.Material[] };

type MaterialSet = { version: number; phases: Map<OitPhase, THREE.Material>; release: () => void };

type Phase = OitPhase | 'foreground';

type DrawEntry = {
  object: Drawable;
  source: THREE.Material | THREE.Material[];
  materials: THREE.Material[];
  states: number[];
  background: boolean;
  phases: Partial<Record<Phase, THREE.Material | THREE.Material[]>>;
  groupOrder: number;
};

type DrawView = { scene: THREE.Scene; groups: Map<number, THREE.Group>; entries: DrawEntry[] };

export interface TransparencyDiagnosticSnapshot {
  algorithm: 'depth-binned';
  bins: number;
  width: number;
  height: number;
  bufferBytes: number;
  materials: number;
  transparentDraws: number;
  contextLost: boolean;
}

function isDrawable(object: THREE.Object3D): object is Drawable {
  return (
    'material' in object &&
    (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points)
  );
}

function category(object: Drawable, material: THREE.Material): 'base' | 'world' | 'foreground' {
  if (object.userData.oitBackground) return 'base';
  if (!material.depthTest) return 'foreground';
  return material.transparent ? 'world' : 'base';
}

/** One transparency pipeline for terrain, built-in GLB/image materials and Line2.
 * Ordered masks are generated separately; depthTest:false annotations draw last.
 * Color accumulation intentionally follows the viewer's existing display-space
 * material outputs, avoiding a second output transfer on the custom terrain.
 */
export class TransparencyRenderer {
  private readonly base: THREE.WebGLRenderTarget;
  private readonly bounds: THREE.WebGLRenderTarget;
  private readonly bins: THREE.WebGLRenderTarget;
  private readonly color: THREE.WebGLRenderTarget;
  private readonly composite: THREE.ShaderMaterial;
  private readonly screen = new THREE.Scene();
  private readonly screenCamera = new THREE.Camera();
  private readonly screenGeometry: THREE.BufferGeometry;
  private readonly hidden = new THREE.Material();
  private readonly variants = new Map<THREE.Material, MaterialSet>();
  private readonly draws = new WeakMap<Drawable, DrawEntry>();
  private readonly views: DrawView[] = Array.from({ length: 3 }, () => {
    const scene = new THREE.Scene();
    scene.matrixWorldAutoUpdate = false;
    return { scene, groups: new Map(), entries: [] };
  });
  private needsValidation = true;
  private readonly restored = () => {
    this.needsValidation = true;
    for (const target of [this.base, this.bounds, this.bins, this.color]) target.dispose();
    for (const set of this.variants.values()) for (const material of set.phases.values()) material.needsUpdate = true;
    this.composite.needsUpdate = true;
  };
  private readonly inverseProjection = { value: new THREE.Matrix4() };
  private readonly size = new THREE.Vector2();
  private readonly projectionView = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private transparentDraws = 0;
  private disposed = false;
  private readonly clearZero = new Float32Array(4);
  private readonly clearBounds = new Float32Array([-1e20, 0, -1, 0]);

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    if (
      !renderer.extensions.has('EXT_color_buffer_float') ||
      !renderer.extensions.has('EXT_float_blend') ||
      gl.getParameter(gl.MAX_DRAW_BUFFERS) < OIT_ATTACHMENT_COUNT ||
      gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) < OIT_ATTACHMENT_COUNT
    ) {
      throw new Error(
        'Depth-binned transparency requires WebGL2 with floating-point render targets, float blending and four color attachments.',
      );
    }
    const options = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false };
    this.base = new THREE.WebGLRenderTarget(1, 1, { ...options, depthBuffer: true });
    this.base.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.bounds = new THREE.WebGLRenderTarget(1, 1, { ...options, type: THREE.FloatType, depthBuffer: false });
    this.bins = new THREE.WebGLRenderTarget(1, 1, {
      ...options,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      count: OIT_ATTACHMENT_COUNT,
    });
    this.color = new THREE.WebGLRenderTarget(1, 1, { ...options, type: THREE.HalfFloatType, depthBuffer: false });
    this.composite = new THREE.ShaderMaterial({
      vertexShader: OIT_FULLSCREEN_VERTEX,
      fragmentShader: OIT_COMPOSITE_FRAGMENT,
      uniforms: {
        opaqueColor: { value: this.base.texture },
        opaqueDepth: { value: this.base.depthTexture },
        accumulation: { value: this.color.texture },
        lastBins: { value: this.bins.textures.at(-1) },
      },
      depthTest: true,
      depthFunc: THREE.AlwaysDepth,
      depthWrite: true,
      blending: THREE.NoBlending,
      toneMapped: false,
    });
    this.screenGeometry = new THREE.BufferGeometry();
    this.screenGeometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const triangle = new THREE.Mesh(this.screenGeometry, this.composite);
    triangle.frustumCulled = false;
    this.screen.add(triangle);
    this.hidden.visible = false;
    const target = renderer.getRenderTarget();
    try {
      for (const buffer of [this.base, this.bounds, this.bins, this.color]) {
        renderer.setRenderTarget(buffer);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error('The GPU cannot allocate the depth-binned transparency framebuffer.');
        }
      }
    } catch (error) {
      this.dispose();
      throw error;
    } finally {
      renderer.setRenderTarget(target);
    }
    renderer.domElement.addEventListener('webglcontextrestored', this.restored);
  }

  private drawEntry(object: Drawable, groupOrder: number): DrawEntry {
    const source = object.material;
    const materials = Array.isArray(source) ? source : [source];
    const state = (m: THREE.Material) =>
      m.version * 8 + Number(m.visible) * 4 + Number(m.transparent) * 2 + Number(m.depthTest);
    let entry = this.draws.get(object);
    if (
      !entry ||
      entry.source !== source ||
      entry.background !== !!object.userData.oitBackground ||
      entry.materials.length !== materials.length ||
      materials.some((m, i) => m !== entry!.materials[i] || state(m) !== entry!.states[i])
    ) {
      entry = {
        object,
        source,
        materials: [...materials],
        states: materials.map(state),
        background: !!object.userData.oitBackground,
        phases: {},
        groupOrder,
      };
      for (const phase of ['base', 'bounds', 'bins', 'color', 'foreground'] as const) {
        let visible = false;
        const selected = materials.map((material) => {
          const kind = category(object, material);
          if (
            !material.visible ||
            (phase === 'foreground' ? kind !== 'foreground' : phase === 'base' ? kind !== 'base' : kind !== 'world')
          )
            return this.hidden;
          visible = true;
          return phase === 'foreground' ? material : this.variant(material, phase);
        });
        if (visible) entry.phases[phase] = Array.isArray(source) ? selected : selected[0];
      }
      this.draws.set(object, entry);
    }
    entry.groupOrder = groupOrder;
    return entry;
  }

  private variant(source: THREE.Material, phase: OitPhase): THREE.Material {
    let set = this.variants.get(source);
    if (set && set.version !== source.version) {
      set.release();
      set = undefined;
    }
    if (!set) {
      const phases = new Map<OitPhase, THREE.Material>();
      const release = () => {
        for (const material of phases.values()) material.dispose();
        source.removeEventListener('dispose', release);
        this.variants.delete(source);
      };
      set = { version: source.version, phases, release };
      source.addEventListener('dispose', release);
      this.variants.set(source, set);
    }
    let material = set.phases.get(phase);
    if (material) return material;
    material = source.clone();
    if (source instanceof THREE.ShaderMaterial && material instanceof THREE.ShaderMaterial) {
      // Animation, fog, per-object masks and LineMaterial resolution stay live.
      material.uniforms = source.uniforms;
    }
    const pass = material;
    pass.onBeforeRender = (renderer, scene, camera, geometry, object, group) => {
      source.onBeforeRender(renderer, scene, camera, geometry, object, group);
      pass.opacity = source.opacity;
      if (source instanceof THREE.PointsMaterial && pass instanceof THREE.PointsMaterial) {
        // Three sizes points using the canvas, even for an offscreen target.
        // Compensate before the bounded scene buffer is upscaled to the canvas.
        pass.size = (source.size * this.base.height) / Math.max(1, this.size.y);
      }
      if (pass instanceof THREE.ShaderMaterial) pass.uniformsNeedUpdate = true;
    };
    for (const key of ['color', 'emissive', 'specular'] as const) {
      if (key in source)
        (pass as unknown as Record<string, unknown>)[key] = (source as unknown as Record<string, unknown>)[key];
    }
    pass.customProgramCacheKey = () =>
      `${source.customProgramCacheKey()}:violet-depth-bins:${phase}:${this.renderer.outputColorSpace}`;
    pass.onBeforeCompile = (shader, renderer) => {
      source.onBeforeCompile(shader, renderer);
      Object.assign(shader.uniforms, {
        violetOpaqueDepth: { value: this.base.depthTexture },
        violetDepthBounds: { value: this.bounds.texture },
        violetBins0: { value: this.bins.textures[0] },
        violetBins1: { value: this.bins.textures[1] },
        violetBins2: { value: this.bins.textures[2] },
        violetBins3: { value: this.bins.textures[3] },
        violetInverseProjection: this.inverseProjection,
      });
      shader.fragmentShader = patchOitFragment(
        shader.fragmentShader,
        phase,
        renderer.outputColorSpace === THREE.SRGBColorSpace,
      );
    };
    if (phase !== 'base') {
      pass.transparent = false;
      pass.depthWrite = false;
      pass.depthTest = false;
      pass.forceSinglePass = true;
      pass.blending = THREE.CustomBlending;
      pass.blendEquation = phase === 'bounds' ? THREE.MaxEquation : THREE.AddEquation;
      pass.blendSrc = THREE.OneFactor;
      pass.blendDst = THREE.OneFactor;
      pass.blendEquationAlpha = null;
      pass.blendSrcAlpha = null;
      pass.blendDstAlpha = null;
      pass.premultipliedAlpha = false;
    }
    set.phases.set(phase, pass);
    return pass;
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    if (this.disposed) return;
    const renderer = this.renderer;
    if (renderer.getContext().isContextLost()) return;
    renderer.getDrawingBufferSize(this.size);
    const [width, height] = oitBufferSize(this.size.x, this.size.y);
    this.inverseProjection.value.copy(camera.projectionMatrixInverse);
    const entries: DrawEntry[] = [];
    const frameCulled: StaticMesh[] = [];
    const lights: THREE.Object3D[] = [];
    this.transparentDraws = 0;
    // Update the owning scene once. Passes below are non-owning, filtered views
    // of its drawables: parents, callbacks, geometry and world matrices stay
    // on their original objects, including nested GLB/line/point renderers.
    scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    this.projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projectionView, THREE.WebGLCoordinateSystem, camera.reversedDepth);
    const visit = (object: THREE.Object3D, groupOrder: number) => {
      if (!object.visible) return;
      const order = object instanceof THREE.Group ? object.renderOrder : groupOrder;
      if (isDrawable(object)) {
        const stableBounds = object instanceof StaticMesh && object.frustumCulled;
        if (!stableBounds || (object.layers.test(camera.layers) && this.frustum.intersectsObject(object))) {
          if (stableBounds) frameCulled.push(object);
          const entry = this.drawEntry(object, order);
          entries.push(entry);
          for (const material of entry.materials)
            if (material.visible && category(object, material) === 'world') this.transparentDraws++;
        }
      } else if (object instanceof THREE.Light) lights.push(object);
      for (const child of object.children) visit(child, order);
    };
    visit(scene, 0);
    const children = new Map<THREE.Object3D, THREE.Object3D[]>();
    for (const object of [...entries.map((entry) => entry.object), ...lights])
      if (object.children.length) {
        children.set(object, object.children);
        object.children = [];
      }
    const target = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    const autoReset = renderer.info.autoReset;
    const cameraAutoUpdate = camera.matrixWorldAutoUpdate;
    camera.matrixWorldAutoUpdate = false;
    const clearColor = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha();
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const phases = ['base', 'bounds', 'foreground'] as const;
    this.views.forEach((view, index) => {
      view.entries.length = 0;
      view.scene.children = [...lights];
      view.scene.background = index === 0 ? scene.background : null;
      view.scene.backgroundIntensity = scene.backgroundIntensity;
      view.scene.backgroundBlurriness = scene.backgroundBlurriness;
      view.scene.backgroundRotation.copy(scene.backgroundRotation);
      view.scene.environment = scene.environment;
      view.scene.environmentIntensity = scene.environmentIntensity;
      view.scene.environmentRotation.copy(scene.environmentRotation);
      view.scene.fog = scene.fog;
      view.scene.overrideMaterial = scene.overrideMaterial;
      for (const group of view.groups.values()) group.children = [];
      for (const entry of entries) {
        if (!entry.phases[phases[index]]) continue;
        view.entries.push(entry);
        let group = view.groups.get(entry.groupOrder);
        if (!group) {
          group = new THREE.Group();
          group.renderOrder = entry.groupOrder;
          view.groups.set(entry.groupOrder, group);
        }
        if (!group.children.length) view.scene.children.push(group);
        group.children.push(entry.object);
      }
      for (const [order, group] of view.groups) if (!group.children.length) view.groups.delete(order);
    });
    const renderPass = (index: number, phase: Phase) => {
      const view = this.views[index];
      for (const entry of view.entries) entry.object.material = entry.phases[phase]!;
      renderer.render(view.scene, camera);
    };
    renderer.autoClear = false;
    if (autoReset) renderer.info.reset();
    renderer.info.autoReset = false;
    try {
      // Static terrain/tiles share one frustum result across all passes. General
      // meshes retain Three's per-pass culling, including callback-driven bounds.
      for (const object of frameCulled) object.frustumCulled = false;
      if (this.needsValidation || this.base.width !== width || this.base.height !== height) {
        for (const buffer of [this.base, this.bounds, this.bins, this.color]) {
          buffer.setSize(width, height);
          renderer.setRenderTarget(buffer);
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            throw new Error(`The GPU cannot allocate the ${width}×${height} transparency framebuffer.`);
          }
        }
      }
      this.needsValidation = false;
      renderer.setRenderTarget(this.base);
      renderer.clear(true, true, false);
      renderPass(0, 'base');
      renderer.setRenderTarget(this.bounds);
      renderer.state.buffers.color.setMask(true);
      gl.clearBufferfv(gl.COLOR, 0, this.clearBounds);
      if (this.transparentDraws) {
        renderPass(1, 'bounds');
      }
      renderer.setRenderTarget(this.bins);
      renderer.state.buffers.color.setMask(true);
      for (let i = 0; i < OIT_ATTACHMENT_COUNT; i++) gl.clearBufferfv(gl.COLOR, i, this.clearZero);
      if (this.transparentDraws) {
        renderPass(1, 'bins');
      }
      renderer.setRenderTarget(this.color);
      renderer.state.buffers.color.setMask(true);
      gl.clearBufferfv(gl.COLOR, 0, this.clearZero);
      if (this.transparentDraws) {
        renderPass(1, 'color');
      }
      renderer.setRenderTarget(target);
      renderer.render(this.screen, this.screenCamera);
      if (this.views[2].entries.length) renderPass(2, 'foreground');
    } finally {
      for (const object of frameCulled) object.frustumCulled = true;
      for (const entry of entries) entry.object.material = entry.source;
      for (const [object, original] of children) object.children = original;
      camera.matrixWorldAutoUpdate = cameraAutoUpdate;
      for (const view of this.views) {
        view.scene.children = [];
        view.entries.length = 0;
        for (const group of view.groups.values()) group.children = [];
      }
      renderer.autoClear = autoClear;
      renderer.info.autoReset = autoReset;
      renderer.setClearColor(clearColor, clearAlpha);
      renderer.setRenderTarget(target);
    }
  }

  diagnosticSnapshot(): TransparencyDiagnosticSnapshot {
    return {
      algorithm: 'depth-binned',
      bins: OIT_BIN_COUNT,
      width: this.base.width,
      height: this.base.height,
      bufferBytes: this.base.width * this.base.height * OIT_BYTES_PER_PIXEL,
      materials: this.variants.size,
      transparentDraws: this.transparentDraws,
      contextLost: this.renderer.getContext().isContextLost(),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.restored);
    for (const set of this.variants.values()) set.release();
    for (const target of [this.base, this.bounds, this.bins, this.color]) target.dispose();
    this.composite.dispose();
    this.screenGeometry.dispose();
    this.hidden.dispose();
    this.screen.clear();
  }
}
