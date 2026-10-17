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

export interface ChunkPayload extends ChunkHashPayload {
  data?: Uint8Array;
  entities?: Uint8Array;
}

export interface ChunkHashPayload {
  cx: number;
  cz: number;
  hash?: string;
  fileHash?: string;
  nbtHash?: string;
  entityHash?: string;
  source?: 'region' | 'chunk';
  region?: { x: number; z: number };
  missing?: boolean;
}

export interface TextureAtlasManifest {
  cacheKey: string;
  image: string;
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
  protocolVersion: 1;
  adminApi: boolean;
  users: boolean;
  worldWrites: boolean;
  dataWrites: boolean;
  diagnostics: boolean;
  contentReads?: boolean;
  contentWrites?: boolean;
  authMode: 'none' | 'static' | 'users';
}

export interface FrontendRuntimeConfig {
  apiBaseUrl?: string;
  capabilityFallback?: 'legacy' | 'error';
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
    if (!['apiBaseUrl', 'capabilityFallback'].includes(key))
      throw new Error(`unknown runtime configuration field: ${key}`);
  if (config.apiBaseUrl !== undefined && typeof config.apiBaseUrl !== 'string')
    throw new Error('apiBaseUrl must be a string');
  if (config.capabilityFallback !== undefined && !['legacy', 'error'].includes(String(config.capabilityFallback)))
    throw new Error('capabilityFallback must be legacy or error');
  return config as FrontendRuntimeConfig;
}

export function parseServiceCapabilities(value: unknown): ServiceCapabilities {
  if (!value || typeof value !== 'object') throw new Error('invalid service capabilities');
  const capabilities = value as ServiceCapabilities;
  if (
    capabilities.protocolVersion !== 1 ||
    !['none', 'static', 'users'].includes(capabilities.authMode) ||
    ['adminApi', 'users', 'worldWrites', 'dataWrites', 'diagnostics'].some(
      (key) => typeof (value as Record<string, unknown>)[key] !== 'boolean',
    )
  )
    throw new Error('invalid service capabilities');
  for (const key of ['contentReads', 'contentWrites'] as const)
    if (capabilities[key] !== undefined && typeof capabilities[key] !== 'boolean')
      throw new Error('invalid service capabilities');
  return {
    ...capabilities,
    contentReads: capabilities.contentReads ?? false,
    contentWrites: capabilities.contentWrites ?? false,
  };
}

export const LEGACY_SERVICE_CAPABILITIES: ServiceCapabilities = {
  protocolVersion: 1,
  adminApi: true,
  users: true,
  worldWrites: true,
  dataWrites: true,
  diagnostics: true,
  authMode: 'users',
};
