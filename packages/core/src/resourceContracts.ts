import { isWorldName } from './worldName.js';
import { isDimensionId } from './dimensionId.js';
import type { ArtifactRef, ResourceErrorCode, ResourceKind, ResourceRef, ResourceViewHead } from './resources.js';

const kinds: readonly ResourceKind[] = [
  'chunk',
  'texture',
  'atlas-image',
  'atlas-manifest',
  'asset-bundle',
  'game-data',
  'top-map-tile',
  'overlay-media',
];

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid resource document');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !keys.includes(key))) throw new TypeError('unknown resource field');
  return item;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096) throw new TypeError('invalid resource string');
  return value;
}

function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError('invalid SHA-256');
  return value;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError('invalid resource integer');
  return value as number;
}

export function parseArtifactRef(value: unknown): ArtifactRef {
  const item = record(value, ['digest', 'bytes', 'mediaType', 'format']);
  const mediaType = text(item.mediaType);
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)) throw new TypeError('invalid resource MIME type');
  return { digest: digest(item.digest), bytes: integer(item.bytes), mediaType, format: text(item.format) };
}

export function parseResourceRef(value: unknown): ResourceRef {
  const item = record(value, ['schemaVersion', 'kind', 'artifact', 'url']);
  if (item.schemaVersion !== 1 || !kinds.includes(item.kind as ResourceKind))
    throw new TypeError('unsupported resource reference');
  const url = text(item.url);
  if (url.startsWith('/') && !url.startsWith('//')) {
    if (url.includes('\\') || [...url].some((char) => char.charCodeAt(0) <= 32) || url.includes('#'))
      throw new TypeError('invalid resource URL');
  } else {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash)
      throw new TypeError('invalid resource URL');
  }
  return { schemaVersion: 1, kind: item.kind as ResourceKind, artifact: parseArtifactRef(item.artifact), url };
}

export function parseResourceViewHead(value: unknown): ResourceViewHead {
  const item = record(value, [
    'schemaVersion',
    'viewId',
    'mode',
    'sourceScope',
    'generation',
    'renderRoot',
    'publicationId',
  ]);
  if (item.schemaVersion !== 1) throw new TypeError('unsupported resource view');
  const base = {
    schemaVersion: 1 as const,
    viewId: text(item.viewId),
    sourceScope: text(item.sourceScope),
    generation: integer(item.generation),
    renderRoot: digest(item.renderRoot),
  };
  if (item.mode === 'public') return { ...base, mode: 'public', publicationId: digest(item.publicationId) };
  if (item.mode !== 'server' || 'publicationId' in item) throw new TypeError('invalid resource delivery mode');
  return { ...base, mode: 'server' };
}

export class ResourceError extends Error {
  constructor(
    readonly code: ResourceErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ResourceError';
  }
}

export function parseResourceSelector(value: unknown): import('./resources.js').ResourceSelector {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid resource selector');
  const v = value as Record<string, unknown>;
  const fields: Record<string, string[]> = {
    chunk: ['world', 'dimension', 'cx', 'cz'],
    atlas: ['textureSetId'],
    texture: ['id'],
    'asset-bundle': [],
    'game-data': ['name'],
    'top-map-tile': ['world', 'dimension', 'rx', 'rz'],
    'overlay-media': ['mapId', 'dimension', 'assetId', 'versionId'],
  };
  if (typeof v.kind !== 'string' || !Object.hasOwn(fields, v.kind))
    throw new TypeError('unsupported resource selector');
  record(v, ['kind', ...fields[v.kind]]);
  for (const key of fields[v.kind]) {
    if (['cx', 'cz', 'rx', 'rz'].includes(key)) {
      if (!Number.isSafeInteger(v[key]) || Math.abs(v[key] as number) > 2147483647)
        throw new TypeError('invalid resource coordinate');
    } else if (typeof v[key] !== 'string' || !(v[key] as string).length || (v[key] as string).length > 256)
      throw new TypeError('invalid selector string');
  }
  if ('world' in v && !isWorldName(v.world)) throw new TypeError('invalid resource world');
  for (const key of ['mapId', 'assetId', 'textureSetId'])
    if (key in v && !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(v[key] as string))
      throw new TypeError('invalid resource identity');
  if ('dimension' in v && !isDimensionId(v.dimension)) throw new TypeError('invalid resource dimension');
  if (
    v.kind === 'texture' &&
    (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(v.id as string) || (v.id as string).split(/[/:]/).includes('..'))
  )
    throw new TypeError('invalid texture id');
  if (v.kind === 'game-data' && !['blocks', 'biomes', 'dimensions'].includes(v.name as string))
    throw new TypeError('invalid game data name');
  if ('versionId' in v) digest(v.versionId);
  return { ...v } as unknown as import('./resources.js').ResourceSelector;
}

export function mediaArtifact(version: { digest: string; bytes: number; mediaType: string }): ArtifactRef {
  const formats: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'model/gltf-binary': 'glb',
  };
  const format = formats[version.mediaType];
  if (!format) throw new TypeError('unsupported media representation');
  return parseArtifactRef({ digest: version.digest, bytes: version.bytes, mediaType: version.mediaType, format });
}

export function parseResolvedResource(value: unknown): import('./resourceTypes.js').ResolvedResource {
  const item = record(value, [
    'selector',
    'missing',
    'resource',
    'manifest',
    'image',
    'nbtHash',
    'terrainHash',
    'entityHash',
  ]);
  const selector = parseResourceSelector(item.selector);
  if (item.missing === true) {
    if (
      !['chunk', 'texture'].includes(selector.kind) ||
      Object.keys(item).some((k) => !['selector', 'missing'].includes(k))
    )
      throw new TypeError('invalid missing resource');
    return { selector, missing: true };
  }
  if ('missing' in item) throw new TypeError('invalid missing discriminator');
  if (selector.kind === 'atlas') {
    if (Object.keys(item).some((k) => !['selector', 'manifest', 'image'].includes(k)))
      throw new TypeError('invalid atlas result');
    const manifest = parseResourceRef(item.manifest),
      image = parseResourceRef(item.image);
    if (
      manifest.kind !== 'atlas-manifest' ||
      image.kind !== 'atlas-image' ||
      manifest.artifact.format !== 'atlas-manifest-v1' ||
      manifest.artifact.mediaType !== 'application/json' ||
      image.artifact.mediaType !== 'image/png' ||
      image.artifact.format !== 'png'
    )
      throw new TypeError('unsupported atlas representation');
    return { selector, manifest, image };
  }
  if ('manifest' in item || 'image' in item) throw new TypeError('mixed resource result');
  const resource = parseResourceRef(item.resource);
  if (resource.kind !== selector.kind) throw new TypeError('resource kind mismatch');
  if (selector.kind === 'chunk') {
    if (resource.artifact.format !== 'chunk-msgpack-v1' || resource.artifact.mediaType !== 'application/msgpack')
      throw new TypeError('unsupported chunk format');
    return {
      selector,
      resource,
      nbtHash: digest(item.nbtHash),
      terrainHash: digest(item.terrainHash),
      ...(item.entityHash !== undefined ? { entityHash: digest(item.entityHash) } : {}),
    };
  }
  const expected: Record<string, [string, string]> = {
    texture: ['png', 'image/png'],
    'asset-bundle': ['asset-bundle-json-v1', 'application/json'],
    'game-data': ['game-data-json-v1', 'application/json'],
    'top-map-tile': ['topmap-msgpack-v6', 'application/msgpack'],
  };
  const representation = expected[selector.kind];
  if (
    representation &&
    (resource.artifact.format !== representation[0] || resource.artifact.mediaType !== representation[1])
  )
    throw new TypeError('unsupported resource representation');
  if (
    selector.kind === 'overlay-media' &&
    (resource.artifact.digest !== selector.versionId ||
      resource.artifact.format !== mediaArtifact(resource.artifact).format)
  )
    throw new TypeError('media business version does not match resource');
  if (Object.keys(item).some((k) => !['selector', 'resource'].includes(k)))
    throw new TypeError('invalid resource result fields');
  return { selector, resource };
}
