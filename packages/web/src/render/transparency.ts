import * as THREE from 'three';
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

type DrawEntry = { object: Drawable; source: THREE.Material | THREE.Material[]; materials: THREE.Material[] };

export interface TransparencyDiagnosticSnapshot {
  algorithm: 'depth-binned';
  bins: number;
  width: number;
  height: number;
  bufferBytes: number;
  materials: number;
  transparentDraws: number;
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
  private readonly inverseProjection = { value: new THREE.Matrix4() };
  private readonly size = new THREE.Vector2();
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
    this.transparentDraws = 0;
    scene.traverseVisible((object) => {
      if (!isDrawable(object)) return;
      const source = object.material;
      const materials = Array.isArray(source) ? source : [source];
      entries.push({ object, source, materials });
      this.transparentDraws += materials.filter(
        (material) => material.visible && category(object, material) === 'world',
      ).length;
    });
    const target = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    const autoReset = renderer.info.autoReset;
    const background = scene.background;
    const clearColor = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha();
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const select = (phase: OitPhase | 'foreground') => {
      for (const entry of entries) {
        const materials = entry.materials.map((source) => {
          if (!source.visible) return this.hidden;
          const kind = category(entry.object, source);
          if (phase === 'foreground') return kind === 'foreground' ? source : this.hidden;
          if ((phase === 'base' && kind !== 'base') || (phase !== 'base' && kind !== 'world')) return this.hidden;
          return this.variant(source, phase);
        });
        entry.object.material = Array.isArray(entry.source) ? materials : materials[0];
      }
    };
    renderer.autoClear = false;
    if (autoReset) renderer.info.reset();
    renderer.info.autoReset = false;
    try {
      if (this.base.width !== width || this.base.height !== height) {
        for (const buffer of [this.base, this.bounds, this.bins, this.color]) {
          buffer.setSize(width, height);
          renderer.setRenderTarget(buffer);
          if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            throw new Error(`The GPU cannot allocate the ${width}×${height} transparency framebuffer.`);
          }
        }
      }
      select('base');
      renderer.setRenderTarget(this.base);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
      scene.background = null;
      renderer.setRenderTarget(this.bounds);
      renderer.state.buffers.color.setMask(true);
      gl.clearBufferfv(gl.COLOR, 0, this.clearBounds);
      if (this.transparentDraws) {
        select('bounds');
        renderer.render(scene, camera);
      }
      renderer.setRenderTarget(this.bins);
      renderer.state.buffers.color.setMask(true);
      for (let i = 0; i < OIT_ATTACHMENT_COUNT; i++) gl.clearBufferfv(gl.COLOR, i, this.clearZero);
      if (this.transparentDraws) {
        select('bins');
        renderer.render(scene, camera);
      }
      renderer.setRenderTarget(this.color);
      renderer.state.buffers.color.setMask(true);
      gl.clearBufferfv(gl.COLOR, 0, this.clearZero);
      if (this.transparentDraws) {
        select('color');
        renderer.render(scene, camera);
      }
      renderer.setRenderTarget(target);
      renderer.render(this.screen, this.screenCamera);
      select('foreground');
      renderer.render(scene, camera);
    } finally {
      for (const entry of entries) entry.object.material = entry.source;
      scene.background = background;
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
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const set of this.variants.values()) set.release();
    for (const target of [this.base, this.bounds, this.bins, this.color]) target.dispose();
    this.composite.dispose();
    this.screenGeometry.dispose();
    this.hidden.dispose();
    this.screen.clear();
  }
}
