import * as THREE from 'three';

export interface SharedUniforms {
  skyDarken: { value: number };
  ambient: { value: number };
  fogColor: { value: THREE.Color };
  envFogColor: { value: THREE.Color };
  envFogDensity: { value: number };
  fogNear: { value: number };
  fogFar: { value: number };
}

const VERT = /* glsl */ `
uniform float positionScale;
uniform float positionOffset;
attribute vec3 tintColor;
attribute vec2 lightData;
varying vec2 vUv;
varying vec3 vColor;
varying vec2 vLight;
varying vec3 vWorldPos;
void main() {
  vUv = uv;
  vColor = tintColor;
  vLight = lightData;
  vec3 scaledPosition = position * positionScale + vec3(positionOffset);
  vec4 world = modelMatrix * vec4(scaledPosition, 1.0);
  vWorldPos = world.xyz;
  vec4 mv = modelViewMatrix * vec4(scaledPosition, 1.0);
  gl_Position = projectionMatrix * mv;
}`;

const TILED_VERT = /* glsl */ `
uniform float positionScale;
uniform float positionOffset;
attribute vec3 tintColor;
attribute vec2 lightData;
attribute vec4 atlasRect;
varying vec2 vUv;
varying vec4 vAtlasRect;
varying vec3 vColor;
varying vec2 vLight;
varying vec3 vWorldPos;
void main() {
  vUv = uv;
  vAtlasRect = atlasRect;
  vColor = tintColor;
  vLight = lightData;
  vec3 scaledPosition = position * positionScale + vec3(positionOffset);
  vec4 world = modelMatrix * vec4(scaledPosition, 1.0);
  vWorldPos = world.xyz;
  vec4 mv = modelViewMatrix * vec4(scaledPosition, 1.0);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform sampler2D map;
uniform float skyDarken;
uniform float ambient;
uniform vec3 fogColor;
uniform vec3 envFogColor;
uniform float envFogDensity;
uniform float fogNear;
uniform float fogFar;
uniform float alphaTest;
uniform float opacity;
varying vec2 vUv;
varying vec3 vColor;
varying vec2 vLight;
varying vec3 vWorldPos;
void main() {
  vec4 tex = texture2D(map, vUv);
  if (tex.a <= alphaTest) discard;
  float l = max(vLight.y, vLight.x * skyDarken);
  float b = ambient + (1.0 - ambient) * l;
  vec3 c = tex.rgb * vColor * b;
  vec3 rel = vWorldPos - cameraPosition;
  float renderDistanceFog = smoothstep(fogNear, fogFar, length(rel.xz));
  float environmentalFog = 1.0 - exp(-max(envFogDensity, 0.0) * length(rel));
  float f = clamp(max(renderDistanceFog, environmentalFog), 0.0, 1.0);
  vec3 fc = mix(envFogColor, fogColor, renderDistanceFog);
  gl_FragColor = vec4(mix(c, fc, f), tex.a * opacity);
}`;

const TILED_FRAG = /* glsl */ `
uniform sampler2D map;
uniform float skyDarken;
uniform float ambient;
uniform vec3 fogColor;
uniform vec3 envFogColor;
uniform float envFogDensity;
uniform float fogNear;
uniform float fogFar;
uniform float alphaTest;
uniform float opacity;
varying vec2 vUv;
varying vec4 vAtlasRect;
varying vec3 vColor;
varying vec2 vLight;
varying vec3 vWorldPos;
void main() {
  vec2 tileUv = clamp(fract(vUv), vec2(0.001), vec2(0.999));
  vec2 atlasUv = mix(vAtlasRect.xy, vAtlasRect.zw, tileUv);
  vec4 tex = texture2D(map, atlasUv);
  if (tex.a <= alphaTest) discard;
  float l = max(vLight.y, vLight.x * skyDarken);
  float b = ambient + (1.0 - ambient) * l;
  vec3 c = tex.rgb * vColor * b;
  vec3 rel = vWorldPos - cameraPosition;
  float renderDistanceFog = smoothstep(fogNear, fogFar, length(rel.xz));
  float environmentalFog = 1.0 - exp(-max(envFogDensity, 0.0) * length(rel));
  float f = clamp(max(renderDistanceFog, environmentalFog), 0.0, 1.0);
  vec3 fc = mix(envFogColor, fogColor, renderDistanceFog);
  gl_FragColor = vec4(mix(c, fc, f), tex.a * opacity);
}`;

export function createSharedUniforms(): SharedUniforms {
  return {
    skyDarken: { value: 1 },
    ambient: { value: 0.18 },
    fogColor: { value: new THREE.Color(0xc0d8ff) },
    envFogColor: { value: new THREE.Color(0xc0d8ff) },
    envFogDensity: { value: 0.0018 },
    fogNear: { value: 100 },
    fogFar: { value: 200 },
  };
}

export interface TerrainMaterials {
  opaque: THREE.ShaderMaterial;
  opaqueTiled: THREE.ShaderMaterial;
  cutout: THREE.ShaderMaterial;
  translucent: THREE.ShaderMaterial;
  lod: THREE.ShaderMaterial;
  all: THREE.ShaderMaterial[];
}

export function createMaterials(atlas: THREE.Texture, shared: SharedUniforms): TerrainMaterials {
  const make = (opts: {
    alphaTest: number;
    transparent?: boolean;
    opacity?: number;
    map?: THREE.Texture;
    tiled?: boolean;
    positionScale?: number;
    positionOffset?: number;
  }) => {
    const transparent = opts.transparent ?? false;
    return new THREE.ShaderMaterial({
      vertexShader: opts.tiled ? TILED_VERT : VERT,
      fragmentShader: opts.tiled ? TILED_FRAG : FRAG,
      uniforms: {
        map: { value: opts.map ?? atlas },
        alphaTest: { value: opts.alphaTest },
        opacity: { value: opts.opacity ?? 1 },
        positionScale: { value: opts.positionScale ?? 18 },
        positionOffset: { value: opts.positionOffset ?? -1 },
        ...shared,
      },
      transparent,
      depthWrite: !transparent,
      side: THREE.FrontSide,
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
    opaqueTiled: make({ alphaTest: 0.001, tiled: true }),
    cutout: make({ alphaTest: 0.5 }),
    translucent: make({ alphaTest: 0.01, transparent: true }),
    lod: make({ alphaTest: 0, map: white, positionScale: 1, positionOffset: 0 }),
  };
  return { ...materials, all: Object.values(materials) };
}
