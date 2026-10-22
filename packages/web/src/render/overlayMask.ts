import * as THREE from 'three';
import { OVERLAY_RENDER_LIMITS } from './overlayLimits';
import { areaMaskLayout, type MaskLayout } from '@violet-map/render/overlays';
import type { SharedUniforms } from './materials';

/** A world-XZ compositing atlas, sampled by every terrain material at the actual surface position. */
export class OverlayMask {
  readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera();
  private target: THREE.WebGLRenderTarget | null = null;
  private signature = '';
  private dirty = true;
  layout: MaskLayout | null = null;
  constructor(private readonly shared: SharedUniforms) {}
  invalidate() {
    this.dirty = true;
  }
  update(
    renderer: THREE.WebGLRenderer,
    bounds: { min: [number, number]; max: [number, number] } | null,
    worldPerPixel: number,
  ) {
    if (!bounds) {
      this.shared.overlayMaskEnabled.value = 0;
      this.disposeTarget();
      return;
    }
    const limit = Math.min(OVERLAY_RENDER_LIMITS.maskPixels, renderer.capabilities.maxTextureSize);
    const layout = areaMaskLayout(bounds, worldPerPixel, limit);
    const signature = [...layout.origin, ...layout.size, layout.width, layout.height].join(',');
    if (signature !== this.signature) {
      this.signature = signature;
      this.dirty = true;
    }
    this.layout = layout;
    if (!this.target || this.target.width !== layout.width || this.target.height !== layout.height) {
      this.target?.dispose();
      this.target = new THREE.WebGLRenderTarget(layout.width, layout.height, {
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: false,
      });
      this.dirty = true;
    }
    this.shared.overlayMaskMap.value = this.target.texture;
    this.shared.overlayMaskOrigin.value.set(...layout.origin);
    this.shared.overlayMaskSize.value.set(...layout.size);
    this.shared.overlayMaskEnabled.value = 1;
    if (!this.dirty) return;
    this.camera.left = -layout.size[0] / 2;
    this.camera.right = layout.size[0] / 2;
    this.camera.top = layout.size[1] / 2;
    this.camera.bottom = -layout.size[1] / 2;
    this.camera.near = 0.1;
    this.camera.far = 10;
    this.camera.position.set(layout.origin[0] + layout.size[0] / 2, 1, layout.origin[1] + layout.size[1] / 2);
    this.camera.up.set(0, 0, -1);
    this.camera.lookAt(this.camera.position.x, 0, this.camera.position.z);
    this.camera.updateProjectionMatrix();
    const previous = renderer.getRenderTarget(),
      clear = renderer.getClearColor(new THREE.Color()),
      alpha = renderer.getClearAlpha(),
      auto = renderer.autoClear;
    try {
      renderer.setRenderTarget(this.target);
      renderer.setClearColor(0, 0);
      renderer.autoClear = true;
      renderer.clear();
      renderer.render(this.scene, this.camera);
      this.dirty = false;
    } finally {
      renderer.setRenderTarget(previous);
      renderer.setClearColor(clear, alpha);
      renderer.autoClear = auto;
    }
  }
  get bytes() {
    return this.target ? this.target.width * this.target.height * 4 : 0;
  }
  private disposeTarget() {
    this.target?.dispose();
    this.target = null;
    this.layout = null;
    this.signature = '';
    this.shared.overlayMaskMap.value = null;
  }
  dispose() {
    this.shared.overlayMaskEnabled.value = 0;
    this.disposeTarget();
    this.scene.clear();
  }
}

export function createMaskMaterial(color: string, opacity: number) {
  const raw = new THREE.Color().setRGB(
    parseInt(color.slice(1, 3), 16) / 255,
    parseInt(color.slice(3, 5), 16) / 255,
    parseInt(color.slice(5, 7), 16) / 255,
    THREE.LinearSRGBColorSpace,
  );
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: raw }, opacity: { value: opacity } },
    vertexShader: 'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: 'uniform vec3 color; uniform float opacity; void main(){gl_FragColor=vec4(color,opacity);}',
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}
