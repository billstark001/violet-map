import * as THREE from 'three';

export interface SharedUniforms {
  skyDarken: { value: number };
  ambient: { value: number };
  fogColor: { value: THREE.Color };
  fogNear: { value: number };
  fogFar: { value: number };
}

const VERT = /* glsl */ `
attribute vec3 tintColor;
attribute vec2 lightData;
varying vec2 vUv;
varying vec3 vColor;
varying vec2 vLight;
varying float vFogDepth;
void main() {
  vUv = uv;
  vColor = tintColor;
  vLight = lightData;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform sampler2D map;
uniform float skyDarken;
uniform float ambient;
uniform vec3 fogColor;
uniform float fogNear;
uniform float fogFar;
uniform float alphaTest;
uniform float opacity;
varying vec2 vUv;
varying vec3 vColor;
varying vec2 vLight;
varying float vFogDepth;
void main() {
  vec4 tex = texture2D(map, vUv);
  if (tex.a <= alphaTest) discard;
  float l = max(vLight.y, vLight.x * skyDarken);
  float b = ambient + (1.0 - ambient) * l;
  vec3 lit = tex.rgb * vColor * b;
  vec3 floorColor = max(tex.rgb * ambient, vec3(ambient * 0.28));
  vec3 c = max(lit, floorColor);
  float f = smoothstep(fogNear, fogFar, vFogDepth);
  gl_FragColor = vec4(mix(c, fogColor, f), tex.a * opacity);
}`;

export function createSharedUniforms(): SharedUniforms {
  return {
    skyDarken: { value: 1 },
    ambient: { value: 0.18 },
    fogColor: { value: new THREE.Color(0xc0d8ff) },
    fogNear: { value: 100 },
    fogFar: { value: 200 },
  };
}

export interface TerrainMaterials {
  opaque: THREE.ShaderMaterial;
  cutout: THREE.ShaderMaterial;
  translucent: THREE.ShaderMaterial;
  lod: THREE.ShaderMaterial;
  all: THREE.ShaderMaterial[];
}

export function createMaterials(atlas: THREE.Texture, shared: SharedUniforms): TerrainMaterials {
  const make = (opts: { alphaTest: number; transparent?: boolean; opacity?: number; map?: THREE.Texture }) => {
    const transparent = opts.transparent ?? false;
    return new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        map: { value: opts.map ?? atlas },
        alphaTest: { value: opts.alphaTest },
        opacity: { value: opts.opacity ?? 1 },
        ...shared,
      },
      transparent,
      depthWrite: !transparent,
      side: THREE.DoubleSide,
    });
  };

  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  white.magFilter = THREE.NearestFilter;
  white.minFilter = THREE.NearestFilter;
  white.wrapS = THREE.ClampToEdgeWrapping;
  white.wrapT = THREE.ClampToEdgeWrapping;
  white.needsUpdate = true;

  const materials = {
    opaque: make({ alphaTest: 0.001 }),
    cutout: make({ alphaTest: 0.5 }),
    translucent: make({ alphaTest: 0.01, transparent: true }),
    lod: make({ alphaTest: 0, map: white }),
  };
  return { ...materials, all: Object.values(materials) };
}
