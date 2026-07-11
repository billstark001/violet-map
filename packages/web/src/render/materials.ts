import * as THREE from 'three';
import { TOP_MAP_POSITION_OFFSET, TOP_MAP_POSITION_SCALE } from '@violet-map/core';
import type { TextureAnimationData } from '../atlas';

export interface SharedUniforms {
  skyDarken: { value: number };
  ambient: { value: number };
  fogColor: { value: THREE.Color };
  envFogColor: { value: THREE.Color };
  envFogDensity: { value: number };
  fogNear: { value: number };
  fogFar: { value: number };
  animationTime: { value: number };
}

export interface TextureAnimationUniforms {
  info: THREE.DataTexture;
  frames: THREE.DataTexture;
  infoSize: THREE.Vector2;
  frameSize: THREE.Vector2;
}

export function createTextureAnimationUniforms(data: TextureAnimationData): TextureAnimationUniforms {
  const configure = (texture: THREE.DataTexture) => {
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture.colorSpace = THREE.NoColorSpace;
    texture.needsUpdate = true;
    return texture;
  };
  return {
    info: configure(new THREE.DataTexture(data.info, data.infoSize[0], data.infoSize[1], THREE.RGBAFormat)),
    frames: configure(new THREE.DataTexture(data.frames, data.frameSize[0], data.frameSize[1], THREE.RGBAFormat)),
    infoSize: new THREE.Vector2(...data.infoSize),
    frameSize: new THREE.Vector2(...data.frameSize),
  };
}

const VERT = /* glsl */ `
uniform vec3 positionScale;
uniform vec3 positionOffset;
attribute vec3 tintColor;
attribute vec2 lightData;
attribute float animationId;
varying vec2 vUv;
varying vec3 vColor;
varying vec2 vLight;
varying vec3 vWorldPos;
varying float vAnimationId;
void main() {
  vUv = uv;
  vColor = tintColor;
  vLight = lightData;
  vec3 scaledPosition = position * positionScale + positionOffset;
  vec4 world = modelMatrix * vec4(scaledPosition, 1.0);
  vWorldPos = world.xyz;
  vAnimationId = animationId;
  vec4 mv = modelViewMatrix * vec4(scaledPosition, 1.0);
  gl_Position = projectionMatrix * mv;
}`;

const TILED_VERT = /* glsl */ `
uniform vec3 positionScale;
uniform vec3 positionOffset;
attribute vec3 tintColor;
attribute vec2 lightData;
attribute vec4 atlasRect;
attribute float animationId;
varying vec2 vUv;
varying vec4 vAtlasRect;
varying vec3 vColor;
varying vec2 vLight;
varying vec3 vWorldPos;
varying float vAnimationId;
void main() {
  vUv = uv;
  vAtlasRect = atlasRect;
  vColor = tintColor;
  vLight = lightData;
  vec3 scaledPosition = position * positionScale + positionOffset;
  vec4 world = modelMatrix * vec4(scaledPosition, 1.0);
  vWorldPos = world.xyz;
  vAnimationId = animationId;
  vec4 mv = modelViewMatrix * vec4(scaledPosition, 1.0);
  gl_Position = projectionMatrix * mv;
}`;

const COLOR_VERT = /* glsl */ `
uniform vec3 positionScale;
uniform vec3 positionOffset;
attribute vec3 tintColor;
attribute vec2 lightData;
varying vec3 vColor;
varying vec2 vLight;
varying vec3 vWorldPos;
void main() {
  vColor = tintColor;
  vLight = lightData;
  vec3 scaledPosition = position * positionScale + positionOffset;
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
uniform sampler2D animationInfo;
uniform sampler2D animationFrames;
uniform vec2 animationInfoSize;
uniform vec2 animationFrameSize;
uniform float animationTime;
varying vec2 vUv;
varying vec3 vColor;
varying vec2 vLight;
varying vec3 vWorldPos;
varying float vAnimationId;
vec2 animationLookupUv(float index, vec2 size) {
  return (vec2(mod(index, size.x), floor(index / size.x)) + 0.5) / size;
}
float animationU16(float hi, float lo) {
  return (floor(hi * 255.0 + 0.5) * 256.0 + floor(lo * 255.0 + 0.5)) / 65535.0;
}
vec4 animatedTexture(vec2 baseUv) {
  if (vAnimationId < 0.5) return texture2D(map, baseUv);
  vec4 info = texture2D(animationInfo, animationLookupUv(floor(vAnimationId + 0.5), animationInfoSize));
  float start = animationU16(info.r, info.g) * 65535.0;
  float count = animationU16(info.b, info.a) * 65535.0;
  if (count < 1.5) return texture2D(map, baseUv);
  float phase = mod(floor(animationTime * 20.0), count);
  float baseIndex = start * 2.0;
  float frameIndex = (start + phase) * 2.0;
  vec4 baseA = texture2D(animationFrames, animationLookupUv(baseIndex, animationFrameSize));
  vec4 baseB = texture2D(animationFrames, animationLookupUv(baseIndex + 1.0, animationFrameSize));
  vec4 frameA = texture2D(animationFrames, animationLookupUv(frameIndex, animationFrameSize));
  vec4 frameB = texture2D(animationFrames, animationLookupUv(frameIndex + 1.0, animationFrameSize));
  vec2 baseMin = vec2(animationU16(baseA.r, baseA.g), animationU16(baseA.b, baseA.a));
  vec2 baseMax = vec2(animationU16(baseB.r, baseB.g), animationU16(baseB.b, baseB.a));
  vec2 frameMin = vec2(animationU16(frameA.r, frameA.g), animationU16(frameA.b, frameA.a));
  vec2 frameMax = vec2(animationU16(frameB.r, frameB.g), animationU16(frameB.b, frameB.a));
  vec2 localUv = clamp((baseUv - baseMin) / max(baseMax - baseMin, vec2(0.00001)), 0.0, 1.0);
  return texture2D(map, mix(frameMin, frameMax, localUv));
}
void main() {
  vec4 tex = animatedTexture(vUv);
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

const COLOR_FRAG = /* glsl */ `
uniform float skyDarken;
uniform float ambient;
uniform vec3 fogColor;
uniform vec3 envFogColor;
uniform float envFogDensity;
uniform float fogNear;
uniform float fogFar;
varying vec3 vColor;
varying vec2 vLight;
varying vec3 vWorldPos;
void main() {
  float l = max(vLight.y, vLight.x * skyDarken);
  float b = ambient + (1.0 - ambient) * l;
  vec3 c = vColor * b;
  vec3 rel = vWorldPos - cameraPosition;
  float renderDistanceFog = smoothstep(fogNear, fogFar, length(rel.xz));
  float environmentalFog = 1.0 - exp(-max(envFogDensity, 0.0) * length(rel));
  float f = clamp(max(renderDistanceFog, environmentalFog), 0.0, 1.0);
  vec3 fc = mix(envFogColor, fogColor, renderDistanceFog);
  gl_FragColor = vec4(mix(c, fc, f), 1.0);
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
    animationTime: { value: 0 },
  };
}

export interface TerrainMaterials {
  opaque: THREE.ShaderMaterial;
  opaqueTiled: THREE.ShaderMaterial;
  cutout: THREE.ShaderMaterial;
  translucent: THREE.ShaderMaterial;
  specialOpaque: THREE.ShaderMaterial;
  specialCutout: THREE.ShaderMaterial;
  specialTranslucent: THREE.ShaderMaterial;
  lod: THREE.ShaderMaterial;
  all: THREE.ShaderMaterial[];
}

interface TerrainMaterialOptions {
  alphaTest?: number;
  transparent?: boolean;
  opacity?: number;
  map?: THREE.Texture;
  tiled?: boolean;
  colorOnly?: boolean;
  positionScale?: THREE.Vector3;
  positionOffset?: THREE.Vector3;
  polygonOffset?: boolean;
  polygonOffsetFactor?: number;
  polygonOffsetUnits?: number;
}

function makeTerrainMaterial(
  atlas: THREE.Texture, shared: SharedUniforms, animation: TextureAnimationUniforms, opts: TerrainMaterialOptions,
): THREE.ShaderMaterial {
  const transparent = opts.transparent ?? false;
  const material = new THREE.ShaderMaterial({
    vertexShader: opts.colorOnly ? COLOR_VERT : opts.tiled ? TILED_VERT : VERT,
    fragmentShader: opts.colorOnly ? COLOR_FRAG : opts.tiled ? TILED_FRAG : FRAG,
    uniforms: {
      ...(opts.colorOnly ? {} : {
        map: { value: opts.map ?? atlas },
        alphaTest: { value: opts.alphaTest ?? 0 },
        opacity: { value: opts.opacity ?? 1 },
      }),
      positionScale: { value: opts.positionScale ?? new THREE.Vector3(18, 18, 18) },
      positionOffset: { value: opts.positionOffset ?? new THREE.Vector3(-1, -1, -1) },
      animationInfo: { value: animation.info },
      animationFrames: { value: animation.frames },
      animationInfoSize: { value: animation.infoSize },
      animationFrameSize: { value: animation.frameSize },
      ...shared,
    },
    transparent,
    depthWrite: !transparent,
    side: THREE.FrontSide,
    polygonOffset: opts.polygonOffset ?? false,
    polygonOffsetFactor: opts.polygonOffsetFactor ?? 0,
    polygonOffsetUnits: opts.polygonOffsetUnits ?? 0,
  });
  // Static meshes deliberately omit the attribute to keep their transfer size
  // small. Three supplies this generic attribute's disabled-array value.
  (material.defaultAttributeValues as unknown as Record<string, number[]>).animationId = [0];
  return material;
}

export function createMaterials(atlas: THREE.Texture, shared: SharedUniforms, animation: TextureAnimationUniforms): TerrainMaterials {
  const materials = {
    opaque: makeTerrainMaterial(atlas, shared, animation, { alphaTest: 0.001 }),
    opaqueTiled: makeTerrainMaterial(atlas, shared, animation, { alphaTest: 0.001, tiled: true }),
    cutout: makeTerrainMaterial(atlas, shared, animation, { alphaTest: 0.5 }),
    translucent: makeTerrainMaterial(atlas, shared, animation, { alphaTest: 0.01, transparent: true }),
    specialOpaque: makeTerrainMaterial(atlas, shared, animation, { alphaTest: 0.001 }),
    specialCutout: makeTerrainMaterial(atlas, shared, animation, { alphaTest: 0.5 }),
    specialTranslucent: makeTerrainMaterial(atlas, shared, animation, { alphaTest: 0.01, transparent: true }),
    lod: makeTerrainMaterial(atlas, shared, animation, {
      colorOnly: true,
      positionScale: new THREE.Vector3(16, 4096, 16),
      positionOffset: new THREE.Vector3(0, -2048, 0),
    }),
  };
  return { ...materials, all: Object.values(materials) };
}

let emptyTextureAnimationUniforms: TextureAnimationUniforms | null = null;
function emptyAnimations(): TextureAnimationUniforms {
  return emptyTextureAnimationUniforms ??= createTextureAnimationUniforms({
    ids: {}, info: new Uint8Array(4), infoSize: [1, 1], frames: new Uint8Array(4), frameSize: [1, 1],
  });
}

export function createTopMapMaterial(map: THREE.Texture, shared: SharedUniforms): THREE.ShaderMaterial {
  return makeTerrainMaterial(map, shared, emptyAnimations(), {
    map,
    alphaTest: 0.05,
    positionScale: new THREE.Vector3(...TOP_MAP_POSITION_SCALE),
    positionOffset: new THREE.Vector3(...TOP_MAP_POSITION_OFFSET),
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 2,
  });
}
