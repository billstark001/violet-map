// Depth bins store a piecewise-linear prefix integral of optical thickness.
// This is the depth-binned transmittance approach used by Minecraft 26.4,
// independently implemented for WebGL2. See docs/transparency.md.
export const OIT_BIN_COUNT = 16;
export const OIT_ATTACHMENT_COUNT = OIT_BIN_COUNT / 4;
export const OIT_MAX_PIXELS = 1_572_864;
export const OIT_BYTES_PER_PIXEL = 64; // color/depth 8, bounds 16, bins 32, accumulation 8

export type OitPhase = 'base' | 'bounds' | 'bins' | 'color';

export function oitBufferSize(width: number, height: number): [number, number] {
  const scale = Math.min(1, Math.sqrt(OIT_MAX_PIXELS / Math.max(1, width * height)));
  return [Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale))];
}

const common = /* glsl */ `
uniform sampler2D violetOpaqueDepth;
uniform sampler2D violetDepthBounds;
uniform sampler2D violetBins0;
uniform sampler2D violetBins1;
uniform sampler2D violetBins2;
uniform sampler2D violetBins3;
uniform mat4 violetInverseProjection;
float violetViewDepth(float z) {
  vec4 v = violetInverseProjection * vec4(0.0, 0.0, z * 2.0 - 1.0, 1.0);
  return -v.z / v.w;
}
float violetOpticalThickness(float alpha) {
  return -log(max(1.0 - clamp(alpha, 0.0, 1.0), 0.000001));
}
float violetBinPosition(vec4 bounds) {
  float depth = violetViewDepth(gl_FragCoord.z);
  // Fully hidden surfaces must not consume the finite visible depth range.
  float visibleFar = min(bounds.y, violetViewDepth(-bounds.z));
  return clamp((depth + bounds.x) / max(visibleFar + bounds.x, 0.00001), 0.0, 1.0) * 15.0;
}
float violetPrefixAt(int index, ivec2 pixel) {
  if (index < 0) return 0.0;
  if (index < 4) return texelFetch(violetBins0, pixel, 0)[index];
  if (index < 8) return texelFetch(violetBins1, pixel, 0)[index - 4];
  if (index < 12) return texelFetch(violetBins2, pixel, 0)[index - 8];
  return texelFetch(violetBins3, pixel, 0)[index - 12];
}
`;

export function patchOitFragment(fragment: string, phase: OitPhase, srgb: boolean): string {
  // Preserve each material's existing screen-space color output. Terrain uses
  // its own color pipeline; built-in materials normally encode at this chunk.
  const output = srgb ? 'gl_FragColor = sRGBTransferOETF(gl_FragColor);' : '';
  fragment = fragment.replace('#include <colorspace_fragment>', output);
  if (phase === 'base') return fragment;
  if (phase === 'bounds' || phase === 'bins') {
    fragment = '#define VIOLET_OIT_ALPHA_ONLY\n' + fragment;
    fragment = fragment.replace(
      '#include <alphahash_fragment>',
      '#include <alphahash_fragment>\ngl_FragColor = vec4(0.0, 0.0, 0.0, diffuseColor.a); return;',
    );
  }
  const entry = /void\s+main\s*\(\s*(?:void)?\s*\)/;
  if (!entry.test(fragment)) throw new Error('OIT material has no fragment entry point');
  fragment = fragment.replace(entry, 'void violetSurface()');
  const outputs =
    phase === 'bins'
      ? 'layout(location=1) out vec4 violetOut1;\nlayout(location=2) out vec4 violetOut2;\nlayout(location=3) out vec4 violetOut3;'
      : '';
  const write =
    phase === 'bounds'
      ? /* glsl */ `
      float depth = violetViewDepth(gl_FragCoord.z);
      gl_FragColor = vec4(-depth, depth, alpha >= 0.999999 ? -gl_FragCoord.z : -1.0, 0.0);
    `
      : phase === 'bins'
        ? /* glsl */ `
        float x = violetBinPosition(bounds);
        float thickness = violetOpticalThickness(alpha);
        vec4 values[4];
        for (int a = 0; a < 4; a++) {
          for (int c = 0; c < 4; c++) {
            values[a][c] = thickness * clamp(float(a * 4 + c + 1) - x, 0.0, 1.0);
          }
        }
        gl_FragColor = values[0];
        violetOut1 = values[1]; violetOut2 = values[2]; violetOut3 = values[3];
      `
        : /* glsl */ `
        float x = violetBinPosition(bounds);
        int index = int(floor(x));
        float f = fract(x);
        // Remove the current fragment's contribution before interpolating the
        // prefix. A single surface must retain exactly its original opacity.
        float a = violetPrefixAt(index - 1, pixel);
        float b = violetPrefixAt(index, pixel) - violetOpticalThickness(alpha) * (1.0 - f);
        float transmission = exp(-max(mix(a, b, f), 0.0));
        gl_FragColor = vec4(surface.rgb * alpha, alpha) * transmission;
      `;
  return (
    common +
    '\n' +
    outputs +
    '\n' +
    fragment +
    /* glsl */ `
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  if (gl_FragCoord.z > texelFetch(violetOpaqueDepth, pixel, 0).r) discard;
  ${
    phase !== 'bounds'
      ? `vec4 bounds = texelFetch(violetDepthBounds, pixel, 0);
  if (gl_FragCoord.z > -bounds.z) discard;`
      : ''
  }
  violetSurface();
  vec4 surface = gl_FragColor;
  float alpha = clamp(surface.a, 0.0, 1.0);
  if (alpha <= 0.0) discard;
  ${write}
}
`
  );
}

export const OIT_FULLSCREEN_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

export const OIT_COMPOSITE_FRAGMENT = /* glsl */ `
uniform sampler2D opaqueColor;
uniform sampler2D opaqueDepth;
uniform sampler2D accumulation;
uniform sampler2D lastBins;
varying vec2 vUv;
void main() {
  vec4 base = texture2D(opaqueColor, vUv);
  vec4 sum = texture2D(accumulation, vUv);
  float transmission = exp(-texture2D(lastBins, vUv).a);
  float coverage = 1.0 - transmission;
  vec3 transparentColor = sum.a > 0.000001 ? sum.rgb * (coverage / sum.a) : vec3(0.0);
  gl_FragColor = vec4(base.rgb * transmission + transparentColor, base.a * transmission + coverage);
  gl_FragDepth = texture2D(opaqueDepth, vUv).r;
}`;
