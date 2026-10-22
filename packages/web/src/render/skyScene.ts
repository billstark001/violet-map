import * as THREE from 'three';
import type { SkyTextureImage, SkyTextureImages } from '../runtime/skyTextures';

const PLANE_FORWARD = new THREE.Vector3(0, 0, 1);

type CelestialMesh = THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

export interface SkyDiagnosticSnapshot {
  sun: string | null;
  moon: string | null;
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

/** Owns sky GPU resources. Sources are verified before construction; no IO or
 * placeholder textures can replace an absent or failed source here. */
export class SkyScene {
  readonly group = new THREE.Group();
  private readonly domeGeometry = new THREE.SphereGeometry(1200, 32, 16);
  private readonly domeMaterial = createSkyDomeMaterial();
  private readonly starGeometry = new THREE.BufferGeometry();
  private readonly starMaterial = new THREE.PointsMaterial({
    color: 0xdde6ff,
    size: 2,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  private celestialGeometry: THREE.PlaneGeometry | null = null;
  private readonly sun: CelestialMesh | null;
  private readonly moon: CelestialMesh | null;
  private readonly sunDirection = new THREE.Vector3();
  private readonly moonDirection = new THREE.Vector3();
  private readonly facing = new THREE.Vector3();
  private disposed = false;

  constructor(
    private readonly scene: THREE.Scene,
    sources: SkyTextureImages,
  ) {
    const dome = new THREE.Mesh(this.domeGeometry, this.domeMaterial);
    dome.frustumCulled = false;
    dome.renderOrder = -1000;
    this.group.add(dome);
    this.sun = this.celestial(sources.sun, 180);
    this.moon = this.celestial(sources.moon, 120);
    const positions = new Float32Array(900 * 3);
    let seed = 1337;
    const rand = () => {
      seed = Math.imul(seed ^ (seed >>> 15), 2246822507);
      seed = Math.imul(seed ^ (seed >>> 13), 3266489909);
      return ((seed ^= seed >>> 16) >>> 0) / 0xffffffff;
    };
    for (let i = 0; i < 900; i++) {
      const y = 0.16 + rand() * 0.84;
      const a = rand() * Math.PI * 2;
      const radius = Math.sqrt(Math.max(0, 1 - y * y));
      positions[i * 3] = Math.cos(a) * radius * 900;
      positions[i * 3 + 1] = y * 900;
      positions[i * 3 + 2] = Math.sin(a) * radius * 900;
    }
    this.starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.group.add(new THREE.Points(this.starGeometry, this.starMaterial));
    this.group.traverse((object) => {
      object.userData.oitBackground = true;
    });
    scene.add(this.group);
  }

  private celestial(source: SkyTextureImage | null, size: number): CelestialMesh | null {
    if (!source) return null;
    const texture = new THREE.Texture(source.image);
    texture.name = source.id;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.colorSpace = THREE.NoColorSpace;
    if (source.layout === 'moon-sheet') {
      const width = Math.floor(source.image.width / 4) / source.image.width;
      const height = Math.floor(source.image.height / 2) / source.image.height;
      texture.repeat.set(width, height);
      texture.offset.set(0, 1 - height);
    }
    texture.needsUpdate = true;
    const material = new THREE.MeshBasicMaterial({
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
    this.celestialGeometry ??= new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.Mesh(this.celestialGeometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -900;
    mesh.scale.set(size, size, 1);
    this.group.add(mesh);
    return mesh;
  }

  update(
    camera: THREE.Camera,
    timeOfDay: number,
    dayFactor: number,
    visible: boolean,
    topColor: THREE.Color,
    horizonColor: THREE.Color,
  ) {
    this.group.position.copy(camera.position);
    this.group.visible = visible;
    if (!visible) return;
    const angle = timeOfDay * Math.PI * 2;
    const sun = this.sunDirection.set(Math.sin(angle), Math.cos(angle), -0.25).normalize();
    const moon = this.moonDirection.copy(sun).multiplyScalar(-1);
    for (const [mesh, direction] of [
      [this.sun, sun],
      [this.moon, moon],
    ] as const) {
      if (!mesh) continue;
      mesh.position.copy(direction).multiplyScalar(850);
      mesh.quaternion.setFromUnitVectors(PLANE_FORWARD, this.facing.copy(direction).negate());
    }
    const night = THREE.MathUtils.clamp((0.55 - dayFactor) / 0.55, 0, 1);
    const sunset = Math.max(0, 1 - Math.abs(sun.y) / 0.34) * Math.min(1, dayFactor * 1.6);
    this.domeMaterial.uniforms.topColor.value.copy(topColor);
    this.domeMaterial.uniforms.horizonColor.value.copy(horizonColor);
    this.domeMaterial.uniforms.sunDir.value.copy(sun);
    this.domeMaterial.uniforms.sunsetAmount.value = sunset;
    this.domeMaterial.uniforms.nightAmount.value = night;
    if (this.sun) this.sun.material.opacity = THREE.MathUtils.clamp(dayFactor * 1.2, 0, 1);
    if (this.moon) this.moon.material.opacity = night * 0.8;
    this.starMaterial.opacity = night * 0.85;
  }

  diagnosticSnapshot(): SkyDiagnosticSnapshot {
    return { sun: this.sun?.material.map?.name ?? null, moon: this.moon?.material.map?.name ?? null };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.group);
    this.domeGeometry.dispose();
    this.domeMaterial.dispose();
    this.starGeometry.dispose();
    this.starMaterial.dispose();
    this.celestialGeometry?.dispose();
    for (const mesh of [this.sun, this.moon]) {
      mesh?.material.map?.dispose();
      mesh?.material.dispose();
    }
    this.group.clear();
  }
}
