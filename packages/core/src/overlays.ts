import { ContentValidationError } from './contentValidation.js';
import { isDimensionId } from './dimensionId.js';
import { isWorldName } from './worldName.js';
import { publicResourceUrl } from './http.js';
import type {
  OverlayFeature,
  LayerDocument,
  LayerBinding,
  MapDocument,
  MapSourceStatus,
  MediaVersion,
  MediaDocument,
  OverlayManifest,
} from './overlayTypes.js';

export type * from './overlayTypes.js';
export { ContentValidationError } from './contentValidation.js';
export { parseStaticGlb } from './formats/staticGlb.js';

function cloneDocument<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneDocument(item)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneDocument(item)])) as T;
  return value;
}

function fail(message: string): never {
  throw new ContentValidationError(message);
}

function record(value: unknown, keys: string[], required: string[] = keys): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected an object');
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) if (!keys.includes(key)) fail(`unknown content field: ${key}`);
  for (const key of required) if (object[key] === undefined) fail(`missing content field: ${key}`);
  return object;
}

export function contentId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) fail('invalid content id');
  return value;
}

function text(value: unknown): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) fail('invalid name');
}

function finite(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('expected a finite number');
  return value;
}

function positive(value: unknown): void {
  if (finite(value) <= 0) fail('expected a positive number');
}

function integer(value: unknown, min = 0): void {
  if (!Number.isSafeInteger(value) || (value as number) < min) fail('invalid integer');
}

function vector(value: unknown, length: number): number[] {
  if (!Array.isArray(value) || value.length !== length) fail(`expected a ${length}D vector`);
  value.forEach(finite);
  return value;
}

function boolean(value: unknown): void {
  if (typeof value !== 'boolean') fail('expected a boolean');
}

function oneOf(value: unknown, values: string[]): void {
  if (typeof value !== 'string' || !values.includes(value)) fail(`expected ${values.join(', ')}`);
}

function array(value: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(`array length must be ${min}..${max}`);
  return value;
}

function unique(items: unknown[], key: string): void {
  const ids = items.map((item) => (item as Record<string, unknown>)[key]);
  if (new Set(ids).size !== ids.length) fail(`duplicate ${key}`);
}

function schema(object: Record<string, unknown>): void {
  if (object.schemaVersion !== 1) throw new ContentValidationError('unsupported schemaVersion', 'UNSUPPORTED_FORMAT');
}

function style(value: unknown, extra: string[] = []): Record<string, unknown> {
  const s = record(value, ['color', 'opacity', ...extra]);
  if (typeof s.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(s.color)) fail('color must be #RRGGBB');
  if (finite(s.opacity) < 0 || (s.opacity as number) > 1) fail('opacity must be 0..1');
  return s;
}

export function normalizeContentDimension(value: unknown): string {
  if (!isDimensionId(value)) fail('invalid dimension id');
  return value.includes(':') ? value : `minecraft:${value}`;
}

function orient(a: number[], b: number[], c: number[]): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: number[], b: number[], p: number[]): boolean {
  return (
    orient(a, b, p) === 0 &&
    p[0] >= Math.min(a[0], b[0]) &&
    p[0] <= Math.max(a[0], b[0]) &&
    p[1] >= Math.min(a[1], b[1]) &&
    p[1] <= Math.max(a[1], b[1])
  );
}

function intersects(a: number[], b: number[], c: number[], d: number[]): boolean {
  const ab1 = orient(a, b, c),
    ab2 = orient(a, b, d),
    cd1 = orient(c, d, a),
    cd2 = orient(c, d, b);
  return (
    (ab1 > 0 !== ab2 > 0 && cd1 > 0 !== cd2 > 0 && ab1 !== 0 && ab2 !== 0 && cd1 !== 0 && cd2 !== 0) ||
    onSegment(a, b, c) ||
    onSegment(a, b, d) ||
    onSegment(c, d, a) ||
    onSegment(c, d, b)
  );
}

export function validateFeature(value: unknown): asserts value is OverlayFeature {
  const common = ['featureId', 'kind'];
  if (!value || typeof value !== 'object') fail('invalid feature');
  const kind = (value as Record<string, unknown>).kind;
  if (kind === 'curve') {
    const f = record(value, [...common, 'nodes', 'closed', 'style']);
    contentId(f.featureId);
    boolean(f.closed);
    const nodes = array(f.nodes, f.closed ? 3 : 2, 4096);
    for (const node of nodes) {
      const n = record(node, ['anchor', 'in', 'out']);
      vector(n.anchor, 3);
      vector(n.in, 3);
      vector(n.out, 3);
    }
    if (
      f.closed &&
      JSON.stringify((nodes[0] as { anchor: unknown }).anchor) ===
        JSON.stringify((nodes.at(-1) as { anchor: unknown }).anchor)
    )
      fail('closed nodes must not repeat the first anchor');
    const s = style(f.style, ['width', 'widthUnit']);
    positive(s.width);
    oneOf(s.widthUnit, ['blocks', 'pixels']);
  } else if (kind === 'area') {
    const f = record(value, [...common, 'ring', 'minY', 'maxY', 'fill', 'wall']);
    contentId(f.featureId);
    if (finite(f.minY) >= finite(f.maxY)) fail('minY must be below maxY');
    style(f.fill);
    const wall = style(f.wall, ['occlusion']);
    oneOf(wall.occlusion, ['terrain', 'always']);
    const ring = array(f.ring, 3, 2048).map((point) => vector(point, 2));
    const n = ring.length;
    let area = 0;
    for (let i = 0; i < n; i++) {
      const a = ring[i],
        b = ring[(i + 1) % n],
        c = ring[(i + 2) % n];
      if (a[0] === b[0] && a[1] === b[1]) fail('ring has duplicate adjacent vertices');
      if (orient(a, b, c) === 0 && (a[0] - b[0]) * (c[0] - b[0]) + (a[1] - b[1]) * (c[1] - b[1]) > 0)
        fail('ring has overlapping adjacent edges');
      area += a[0] * b[1] - b[0] * a[1];
      for (let j = i + 1; j < n; j++)
        if (j !== i + 1 && !(i === 0 && j === n - 1) && intersects(a, b, ring[j], ring[(j + 1) % n]))
          fail('ring must not self-intersect or touch');
    }
    if (!Number.isFinite(area) || area === 0) fail('ring must have finite nonzero area');
  } else if (kind === 'media') {
    const f = record(
      value,
      [
        ...common,
        'assetId',
        'versionId',
        'position',
        'rotation',
        'scale',
        'views',
        'placement',
        'size',
        'anchor',
        'lighting',
      ],
      [...common, 'assetId', 'versionId', 'position', 'rotation', 'scale', 'views', 'placement'],
    );
    contentId(f.featureId);
    contentId(f.assetId);
    contentId(f.versionId);
    vector(f.position, 3);
    vector(f.rotation, 3);
    vector(f.scale, 3).forEach(positive);
    const views = array(f.views, 1, 2);
    views.forEach((view) => oneOf(view, ['top', 'player']));
    if (new Set(views).size !== views.length) fail('duplicate view');
    oneOf(f.placement, ['model', 'plane', 'billboard', 'upright']);
    if (f.lighting !== undefined) oneOf(f.lighting, ['label', 'scene']);
    if (f.placement === 'model') {
      if (f.size !== undefined || f.anchor !== undefined) fail('model placement uses scale');
    } else {
      vector(f.size, 2).forEach(positive);
      vector(f.anchor, 2).forEach((value) => {
        if (value < 0 || value > 1) fail('anchor must be 0..1');
      });
    }
  } else fail('unknown feature kind');
}

export function parseLayerDocument(value: unknown): LayerDocument {
  const d = record(value, ['schemaVersion', 'layerId', 'revision', 'name', 'features']);
  schema(d);
  contentId(d.layerId);
  integer(d.revision, 1);
  text(d.name);
  const features = array(d.features, 0, 10000);
  features.forEach(validateFeature);
  unique(features, 'featureId');
  return cloneDocument(value as LayerDocument);
}

export function parseBinding(value: unknown): LayerBinding {
  const d = record(value, ['bindingId', 'dimension', 'layerId', 'enabled', 'order']);
  contentId(d.bindingId);
  contentId(d.layerId);
  boolean(d.enabled);
  integer(d.order, -2147483648);
  return { ...(value as LayerBinding), dimension: normalizeContentDimension(d.dimension) };
}

export function parseMapDocument(value: unknown): MapDocument {
  const d = record(
    value,
    ['schemaVersion', 'mapId', 'revision', 'name', 'worldKey', 'expectedArchiveId', 'bindings'],
    ['schemaVersion', 'mapId', 'revision', 'name', 'worldKey', 'bindings'],
  );
  schema(d);
  contentId(d.mapId);
  integer(d.revision, 1);
  text(d.name);
  if (d.worldKey !== null && !isWorldName(d.worldKey)) fail('worldKey must be a world directory name or null');
  if (d.expectedArchiveId !== undefined) contentId(d.expectedArchiveId);
  const bindings = array(d.bindings, 0, 10000).map(parseBinding);
  unique(bindings, 'bindingId');
  return { ...cloneDocument(value as MapDocument), bindings };
}

export function parseMediaDocument(value: unknown): MediaDocument {
  const d = record(value, ['schemaVersion', 'assetId', 'revision', 'name', 'versions']);
  schema(d);
  contentId(d.assetId);
  integer(d.revision, 1);
  text(d.name);
  const versions = array(d.versions, 1, 10000);
  versions.forEach(contentId);
  if (new Set(versions).size !== versions.length) fail('duplicate version');
  return cloneDocument(value as MediaDocument);
}

export function parseMediaVersion(value: unknown): MediaVersion {
  const d = record(
    value,
    [
      'schemaVersion',
      'assetId',
      'versionId',
      'digest',
      'bytes',
      'mediaType',
      'width',
      'height',
      'bounds',
      'dependencies',
      'blob',
    ],
    ['schemaVersion', 'assetId', 'versionId', 'digest', 'bytes', 'mediaType', 'dependencies', 'blob'],
  );
  schema(d);
  contentId(d.assetId);
  contentId(d.versionId);
  integer(d.bytes, 1);
  if (
    typeof d.digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(d.digest) ||
    d.versionId !== d.digest ||
    d.blob !== `sha256/${d.digest.slice(0, 2)}/${d.digest}`
  )
    fail('invalid content digest/reference');
  oneOf(d.mediaType, ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'model/gltf-binary']);
  array(d.dependencies, 0, 0);
  if (d.mediaType === 'model/gltf-binary') {
    const bounds = record(d.bounds, ['min', 'max']);
    const min = vector(bounds.min, 3),
      max = vector(bounds.max, 3);
    if (min.some((v, i) => v > max[i])) fail('invalid model bounds');
    if (d.width !== undefined || d.height !== undefined) fail('model uses bounds');
  } else {
    positive(d.width);
    positive(d.height);
    if (d.bounds !== undefined) fail('images use dimensions');
  }
  return cloneDocument(value as MediaVersion);
}

export function revisionTag(revision: number): string {
  return `"${revision}"`;
}

/** Validate the public wire document before it crosses into the renderer. */
export function parseOverlayManifest(value: unknown): OverlayManifest {
  const d = record(value, ['schemaVersion', 'mapId', 'mapRevision', 'dimension', 'sourceStatus', 'layers', 'media']);
  schema(d);
  contentId(d.mapId);
  integer(d.mapRevision, 1);
  oneOf(d.sourceStatus, ['verified', 'unverified', 'missing', 'mismatch', 'unbound']);
  const dimension = normalizeContentDimension(d.dimension);
  const layers = array(d.layers, 0, 10000).map((value) => {
    const item = record(value, ['binding', 'document']);
    const binding = parseBinding(item.binding),
      document = parseLayerDocument(item.document);
    if (binding.layerId !== document.layerId || binding.dimension !== dimension || !binding.enabled)
      fail('manifest binding mismatch');
    return { binding, document };
  });
  if (new Set(layers.map((item) => item.binding.bindingId)).size !== layers.length) fail('duplicate binding');
  const media = array(d.media, 0, 10000).map((value) => {
    const item = record(value, ['version', 'url', 'publicUrl'], ['version', 'url']);
    const version = parseMediaVersion(item.version);
    if (typeof item.url !== 'string' || !item.url.startsWith('/api/')) fail('invalid API resource reference');
    let publicUrl: string | undefined;
    if (item.publicUrl !== undefined) {
      try {
        publicUrl = publicResourceUrl(item.publicUrl);
      } catch {
        fail('invalid public media URL');
      }
    }
    return { version, url: item.url, ...(publicUrl ? { publicUrl } : {}) };
  });
  if (new Set(media.map((item) => item.version.assetId + '/' + item.version.versionId)).size !== media.length)
    fail('duplicate media version');
  return {
    schemaVersion: 1,
    mapId: d.mapId as string,
    mapRevision: d.mapRevision as number,
    dimension,
    sourceStatus: d.sourceStatus as MapSourceStatus,
    layers,
    media,
  };
}
