import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { DOMParser } from '@xmldom/xmldom';
import { ContentValidationError, parseMediaVersion, type MediaVersion, type Vec3 } from '@violet-map/core/overlays';

function invalid(message: string): never {
  throw new ContentValidationError(message);
}
function unsupported(message: string): never {
  throw new ContentValidationError(message, 'UNSUPPORTED_FORMAT');
}
const pixelLimit = 16_777_216;
function svgDimensions(bytes: Uint8Array) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/<!DOCTYPE|<!ENTITY|<\?(?!xml(?:\s|\?))/i.test(text))
    unsupported('SVG declarations and entities are unsupported');
  const document = new DOMParser({ onError: () => invalid('malformed SVG') }).parseFromString(text, 'image/svg+xml');
  const root = document.documentElement;
  if (!root || root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg')
    invalid('expected SVG namespace and root');
  // A static path/shape subset: text must be converted to paths by the importer.
  const tags = new Set([
    'svg',
    'g',
    'defs',
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    'linearGradient',
    'radialGradient',
    'stop',
    'clipPath',
    'mask',
    'use',
    'title',
    'desc',
  ]);
  const attrs = new Set([
    'id',
    'viewBox',
    'width',
    'height',
    'x',
    'y',
    'x1',
    'x2',
    'y1',
    'y2',
    'cx',
    'cy',
    'r',
    'rx',
    'ry',
    'd',
    'points',
    'transform',
    'fill',
    'fill-rule',
    'fill-opacity',
    'stroke',
    'stroke-width',
    'stroke-opacity',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-miterlimit',
    'stroke-dasharray',
    'stroke-dashoffset',
    'opacity',
    'clip-path',
    'clip-rule',
    'mask',
    'href',
    'gradientUnits',
    'gradientTransform',
    'spreadMethod',
    'offset',
    'stop-color',
    'stop-opacity',
    'preserveAspectRatio',
    'version',
  ]);
  const nodes = document.getElementsByTagName('*');
  for (let i = 0; i < nodes.length; i++) {
    const element = nodes.item(i)!;
    if (element.namespaceURI !== root.namespaceURI || !tags.has(element.localName ?? ''))
      unsupported(`unsupported SVG element: ${element.localName}`);
    for (let j = 0; j < element.attributes.length; j++) {
      const attr = element.attributes.item(j)!;
      if (attr.namespaceURI === 'http://www.w3.org/2000/xmlns/') continue;
      if (
        !attrs.has(attr.localName ?? '') ||
        (attr.namespaceURI && attr.namespaceURI !== 'http://www.w3.org/1999/xlink')
      )
        unsupported(`unsupported SVG attribute: ${attr.name}`);
      if (attr.localName === 'href' && !/^#[A-Za-z_][\w:.-]*$/.test(attr.value))
        unsupported('SVG references must be local fragments');
      if (/url\s*\(/i.test(attr.value) && !/^url\(#[A-Za-z_][\w:.-]*\)$/.test(attr.value))
        unsupported('SVG URLs must be local fragments');
    }
  }
  const length = (value: string | null) =>
    value && /^(?:\d+(?:\.\d*)?|\.\d+)(?:px)?$/.test(value) ? Number(value.replace(/px$/, '')) : undefined;
  const viewBox = root
    .getAttribute('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (
    viewBox &&
    (viewBox.length !== 4 || viewBox.some((v) => !Number.isFinite(v)) || viewBox[2] <= 0 || viewBox[3] <= 0)
  )
    invalid('invalid SVG viewBox');
  const width = length(root.getAttribute('width')) ?? viewBox?.[2],
    height = length(root.getAttribute('height')) ?? viewBox?.[3];
  if (!width || !height || width * height > pixelLimit)
    invalid('SVG requires positive pixel dimensions or viewBox within pixel limit');
  return { width, height };
}
type GltfNode = {
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  skin?: number;
};
interface Gltf {
  asset: { version: string };
  animations?: unknown[];
  skins?: unknown[];
  buffers?: { uri?: string }[];
  images?: { uri?: string; bufferView?: number; mimeType?: string }[];
  nodes?: GltfNode[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
  meshes?: { primitives: { attributes: Record<string, number>; targets?: unknown[] }[] }[];
  accessors?: { min?: number[]; max?: number[] }[];
}
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function multiply(a: number[], b: number[]): number[] {
  return Array.from({ length: 16 }, (_, i) => {
    const row = i % 4,
      col = Math.floor(i / 4);
    return (
      a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3]
    );
  });
}
function matrix(node: GltfNode): number[] {
  if (node.matrix) return node.matrix;
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1],
    s = node.scale ?? [1, 1, 1],
    t = node.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * s[0],
    2 * (x * y + z * w) * s[0],
    2 * (x * z - y * w) * s[0],
    0,
    2 * (x * y - z * w) * s[1],
    (1 - 2 * (x * x + z * z)) * s[1],
    2 * (y * z + x * w) * s[1],
    0,
    2 * (x * z + y * w) * s[2],
    2 * (y * z - x * w) * s[2],
    (1 - 2 * (x * x + y * y)) * s[2],
    0,
    ...t,
    1,
  ];
}
async function glbBounds(bytes: Uint8Array): Promise<{ min: Vec3; max: Vec3 }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < 20 ||
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== bytes.length ||
    view.getUint32(16, true) !== 0x4e4f534a ||
    20 + view.getUint32(12, true) > bytes.length
  )
    invalid('invalid GLB 2.0 container');
  const raw: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true))));
  const checkExtensions = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (
        (key === 'extensions' || key === 'extensionsUsed' || key === 'extensionsRequired') &&
        child &&
        Object.keys(child).length
      )
        unsupported('GLB extensions, including compression, are unsupported in schema 1');
      checkExtensions(child);
    }
  };
  checkExtensions(raw);
  const gltf = raw as Gltf;
  if (
    gltf.animations?.length ||
    gltf.skins?.length ||
    gltf.nodes?.some((n) => n.skin !== undefined) ||
    gltf.meshes?.some((m) => m.primitives.some((p) => p.targets?.length))
  )
    unsupported('GLB must be static without animation, skins or morph targets');
  if (
    gltf.buffers?.some((b) => b.uri !== undefined) ||
    gltf.images?.some(
      (i) =>
        i.uri !== undefined || i.bufferView === undefined || !['image/png', 'image/jpeg'].includes(i.mimeType ?? ''),
    )
  )
    unsupported('GLB dependencies must be embedded PNG/JPEG buffer views');
  const { validateBytes } = createRequire(import.meta.url)('gltf-validator') as {
    validateBytes(
      bytes: Uint8Array,
      options: { format: string; maxIssues: number; externalResourceFunction: () => Promise<never> },
    ): Promise<{ issues: { numErrors: number } }>;
  };
  const report = await validateBytes(bytes, {
    format: 'glb',
    maxIssues: 20,
    externalResourceFunction: async () => invalid('external GLB dependency'),
  });
  if (report.issues.numErrors) invalid('GLB validation failed');
  const min: Vec3 = [Infinity, Infinity, Infinity],
    max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const visit = (index: number, parent: number[], depth: number) => {
    if (depth > 256) invalid('GLB scene hierarchy exceeds limit');
    const node = gltf.nodes?.[index];
    if (!node) invalid('invalid GLB node');
    const transform = multiply(parent, matrix(node));
    if (node.mesh !== undefined)
      for (const primitive of gltf.meshes![node.mesh].primitives) {
        const accessor = gltf.accessors?.[primitive.attributes.POSITION];
        if (!accessor?.min || !accessor.max) invalid('GLB requires position bounds');
        for (let mask = 0; mask < 8; mask++) {
          const p = accessor.min.map((v, i) => (mask & (1 << i) ? accessor.max![i] : v));
          for (let i = 0; i < 3; i++) {
            const v = transform[i] * p[0] + transform[i + 4] * p[1] + transform[i + 8] * p[2] + transform[i + 12];
            min[i] = Math.min(min[i], v);
            max[i] = Math.max(max[i], v);
          }
        }
      }
    for (const child of node.children ?? []) visit(child, transform, depth + 1);
  };
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  if (!scene) invalid('GLB requires a scene');
  for (const index of scene.nodes ?? []) visit(index, identity, 0);
  if ([...min, ...max].some((v) => !Number.isFinite(v))) invalid('GLB requires finite scene bounds');
  return { min, max };
}
export async function inspectMedia(assetId: string, bytes: Uint8Array, mediaType: string): Promise<MediaVersion> {
  if (!bytes.length) invalid('empty media');
  const digest = createHash('sha256').update(bytes).digest('hex');
  let dimensions: { width?: number; height?: number; bounds?: { min: Vec3; max: Vec3 } };
  try {
    if (mediaType === 'image/svg+xml') dimensions = svgDimensions(bytes);
    else if (mediaType === 'model/gltf-binary') dimensions = { bounds: await glbBounds(bytes) };
    else if (['image/png', 'image/jpeg', 'image/webp'].includes(mediaType)) {
      const image = sharp(bytes, { failOn: 'warning', limitInputPixels: pixelLimit });
      const meta = await image.metadata();
      if (`image/${meta.format}` !== mediaType || (meta.pages ?? 1) > 1)
        invalid('media type mismatch or animated image');
      await image.stats();
      dimensions = { width: meta.width, height: meta.height };
    } else unsupported('unsupported media type');
  } catch (error) {
    if (error instanceof ContentValidationError) throw error;
    invalid('malformed media bytes');
  }
  return parseMediaVersion({
    schemaVersion: 1,
    assetId,
    versionId: digest,
    digest,
    bytes: bytes.length,
    mediaType,
    ...dimensions,
    dependencies: [],
    blob: `sha256/${digest.slice(0, 2)}/${digest}`,
  });
}
