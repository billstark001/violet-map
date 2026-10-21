import type { AtlasIndex, TextureAlphaMap } from './assets.js';
import type { TopMapTileSetManifest } from './formats/topMap.js';

export const ALL_ROLES = ['guest', 'viewer', 'ci', 'admin', 'root'] as const;
export const CREATABLE_ROLES = ['viewer', 'ci', 'admin'] as const;

export type Role = (typeof ALL_ROLES)[number];

export type CreatableRole = (typeof CREATABLE_ROLES)[number];

export type AdminErrorCode = 'INVALID_INPUT' | 'USER_NOT_FOUND' | 'USER_EXISTS' | 'FORBIDDEN';

export interface PublicUser {
  id: string;
  username: string;
  role: Role;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
  virtual?: boolean;
}

export interface IssuedCredential {
  token: string;
  expiresAt: string;
  user: PublicUser;
}

export interface DimensionCapabilities {
  hasTopMap: boolean;
}

export interface WorldCapabilities {
  world: string;
  hasTopMap: boolean;
  dimensions: Record<string, DimensionCapabilities>;
}

export interface TopMapDimensionManifest extends DimensionCapabilities {
  world: string;
  dimension: string;
  topMap?: TopMapTileSetManifest;
}

export interface ChunkPayload extends ChunkIdentityPayload {
  data?: Uint8Array;
  entities?: Uint8Array;
}

export interface ChunkIdentityPayload {
  cx: number;
  cz: number;
  contentDigest?: string;
  terrainDigest?: string;
  entityDigest?: string;
  missing?: boolean;
}

export interface AtlasDocument {
  schemaVersion: 1;
  image: import('./resourceTypes.js').ArtifactRef;
  width: number;
  height: number;
  index: AtlasIndex;
  avgColors: Record<string, [number, number, number]>;
  hasAlpha: TextureAlphaMap;
}

export interface TextureAtlasManifest {
  cacheKey: string;
  image: import('./resourceTypes.js').ResourceRef;
  width: number;
  height: number;
  index: AtlasIndex;
  avgColors: Record<string, [number, number, number]>;
  hasAlpha: TextureAlphaMap;
}

export interface DiagnosticUploadResponse {
  ok: true;
  id: string;
}

export interface WorldInfo {
  id: string;
  dimensions: string[];
  mapIds?: string[];
}

export interface WorldFileManifestEntry {
  path: string;
  size: number;
  modifiedAt?: number;
  etag?: string;
  hash: string;
}

export interface ChunkCoverage {
  regions: { x: number; z: number; mask: string }[];
  chunks: { cx: number; cz: number }[];
}

export interface ServiceCapabilities {
  protocolVersion: 2;
  resourcesProtocol: 1;
  delivery: { mode: 'server' | 'public'; families: import('./resourceTypes.js').ResourceKind[] };
  adminApi: boolean;
  users: boolean;
  worldReads: boolean;
  worldWrites: boolean;
  dataWrites: boolean;
  diagnostics: boolean;
  contentReads: boolean;
  contentWrites: boolean;
  authMode: 'none' | 'static' | 'users';
}

export interface FrontendRuntimeConfig {
  apiBaseUrl?: string;
}

export function asCreatableRole(value: unknown): CreatableRole | undefined {
  return CREATABLE_ROLES.includes(value as CreatableRole) ? (value as CreatableRole) : undefined;
}

/** Normalize the API deployment prefix independently of the static application's base. */
export function normalizeApiBaseUrl(value: string, origin: string): string {
  if (!value || (!value.startsWith('/') && !/^https?:\/\//.test(value)) || value.startsWith('//'))
    throw new Error('apiBaseUrl must be an HTTP(S) URL or an origin-relative path');
  const url = new URL(value, origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('apiBaseUrl must not contain credentials, query, or fragment');
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  return url.href;
}

export function apiUrl(baseUrl: string, path: string): string {
  const relative = path;
  if (!relative.startsWith('api/') || relative.includes('\\') || relative.split(/[/?]/).includes('..'))
    throw new Error('invalid API path');
  const base = new URL(baseUrl);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const url = new URL(relative, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
    throw new Error('API path escapes deployment prefix');
  return url.href;
}

export function resolveApiResourceUrl(baseUrl: string, resource: string): string {
  if (resource.startsWith('/api/')) return apiUrl(baseUrl, resource.slice(1));
  const base = new URL(baseUrl);
  const url = new URL(resource, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.username || url.password)
    throw new Error('resource URL must belong to the configured API');
  return url.href;
}

export function parseFrontendRuntimeConfig(value: unknown): FrontendRuntimeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('runtime-config.json must be an object');
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config))
    if (!['apiBaseUrl'].includes(key)) throw new Error(`unknown runtime configuration field: ${key}`);
  if (config.apiBaseUrl !== undefined && typeof config.apiBaseUrl !== 'string')
    throw new Error('apiBaseUrl must be a string');
  return config as FrontendRuntimeConfig;
}

export function parseServiceCapabilities(value: unknown): ServiceCapabilities {
  if (!value || typeof value !== 'object') throw new Error('invalid service capabilities');
  if (
    Object.keys(value).some(
      (key) =>
        ![
          'protocolVersion',
          'resourcesProtocol',
          'delivery',
          'adminApi',
          'users',
          'worldReads',
          'worldWrites',
          'dataWrites',
          'diagnostics',
          'contentReads',
          'contentWrites',
          'authMode',
        ].includes(key),
    )
  )
    throw new Error('unknown service capability');
  const capabilities = value as ServiceCapabilities;
  if (
    capabilities.protocolVersion !== 2 ||
    capabilities.resourcesProtocol !== 1 ||
    !capabilities.delivery ||
    Object.keys(capabilities.delivery).some((key) => !['mode', 'families'].includes(key)) ||
    !['server', 'public'].includes(capabilities.delivery.mode) ||
    !Array.isArray(capabilities.delivery.families) ||
    new Set(capabilities.delivery.families).size !== capabilities.delivery.families.length ||
    capabilities.delivery.families.some(
      (kind) =>
        ![
          'chunk',
          'texture',
          'atlas-image',
          'atlas-manifest',
          'asset-bundle',
          'game-data',
          'top-map-tile',
          'overlay-media',
        ].includes(kind),
    ) ||
    !['none', 'static', 'users'].includes(capabilities.authMode) ||
    ['adminApi', 'users', 'worldReads', 'worldWrites', 'dataWrites', 'diagnostics'].some(
      (key) => typeof (value as Record<string, unknown>)[key] !== 'boolean',
    )
  )
    throw new Error('invalid service capabilities');
  for (const key of ['contentReads', 'contentWrites'] as const)
    if (typeof capabilities[key] !== 'boolean') throw new Error('invalid service capabilities');
  return capabilities;
}
