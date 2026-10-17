import path from 'node:path';
import fs from 'node:fs';
import type { S3StorageOptions } from '@violet-map/storage/types';
import { findYamlConfig, type YamlValue } from './configYaml.js';
import type { DatabaseOptions } from './db/connection.js';
import type { RootOptions } from './users.js';
import type { CreatableRole, ServiceCapabilities } from '@violet-map/core/contracts';
import { createPublicObjectUrl } from '@violet-map/storage';

export interface ConfigurationOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  configFile?: string;
}

const fields = [
  'deployment.profile',
  'server.port',
  'server.staticDir',
  'server.cors.origins',
  'port',
  'worldsDir',
  'worlds.dir',
  'worldStorage',
  'storage.driver',
  's3.endpoint',
  's3.region',
  's3.bucket',
  's3.prefix',
  's3.forcePathStyle',
  'assetsDirs',
  'assets.dirs',
  'dataDir',
  'data.dir',
  'databaseDir',
  'database.dir',
  'mcVersion',
  'minecraft.version',
  'mcDataVersion',
  'minecraft.dataVersion',
  'features.adminApi',
  'features.users',
  'features.worldWrites',
  'features.dataWrites',
  'features.diagnostics',
  'features.contentReads',
  'features.contentWrites',
  'content.mediaPublicBaseUrl',
  'auth.mode',
  'auth.staticRole',
  'cache.regionBytes',
  'cache.chunkNbtBytes',
  'cache.textureBytes',
  'cache.storageStatMs',
  'cache.storageListMs',
  'cache.manifestMs',
  'cache.worldListMs',
  'cache.prewarm',
  'limits.chunkReads',
  'limits.chunkQueue',
  'limits.chunkRequestBytes',
  'limits.atlasRequestBytes',
  'limits.diagnosticBytes',
  'limits.uploadBytes',
  'limits.atlasBuilds',
  'limits.atlasQueue',
];

function settings(options: ConfigurationOptions) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const yaml = findYamlConfig({ env, cwd, file: options.configFile });
  const base = yaml ? path.dirname(yaml.file) : cwd;
  function validate(value: YamlValue, prefix = '') {
    if (!value || Array.isArray(value) || typeof value !== 'object')
      throw new Error(`configuration ${prefix || 'root'} must be a mapping`);
    for (const [key, child] of Object.entries(value)) {
      const field = prefix ? `${prefix}.${key}` : key;
      const namedBackend =
        /^storage\.backends\.[a-z][a-z0-9]*\.(driver|root|endpoint|region|bucket|forcePathStyle|accessKeyIdEnv|secretAccessKeyEnv|sessionTokenEnv)$/.test(
          field,
        );
      const namedMount = /^storage\.mounts\.(worlds|content|blobs)\.(backend|prefix)$/.test(field);
      if (fields.includes(field) || namedBackend || namedMount) {
        const isBoolean =
          field.startsWith('features.') ||
          ['s3.forcePathStyle', 'cache.prewarm'].includes(field) ||
          field.endsWith('.forcePathStyle');
        const isNumber =
          ['port', 'server.port'].includes(field) ||
          field.startsWith('limits.') ||
          (field.startsWith('cache.') && field !== 'cache.prewarm');
        const isList = ['assetsDirs', 'assets.dirs', 'server.cors.origins'].includes(field);
        const valid = isBoolean
          ? typeof child === 'boolean'
          : isNumber
            ? typeof child === 'number' && Number.isSafeInteger(child)
            : isList
              ? typeof child === 'string' ||
                (Array.isArray(child) && child.every((item) => typeof item === 'string' && item.trim()))
              : typeof child === 'string';
        if (!valid) throw new Error(`invalid configuration type: ${field}`);
        continue;
      }
      if (
        !fields.some((allowed) => allowed.startsWith(`${field}.`)) &&
        !/^storage\.(backends(?:\.[a-z][a-z0-9]*)?|mounts(?:\.(worlds|content|blobs))?)$/.test(field)
      )
        throw new Error(`unknown configuration field: ${field}`);
      validate(child, field);
    }
  }
  if (yaml) validate(yaml.data);
  function yamlValue(...keys: string[]): YamlValue | undefined {
    const values = keys
      .map((key) => {
        let value: YamlValue | undefined = yaml?.data;
        for (const part of key.split('.'))
          value = value && !Array.isArray(value) && typeof value === 'object' ? value[part] : undefined;
        return value;
      })
      .filter((value) => value !== undefined);
    if (values.some((value) => JSON.stringify(value) !== JSON.stringify(values[0])))
      throw new Error(`conflicting configuration fields: ${keys.join(', ')}`);
    return values[0];
  }
  function raw(name: string, fallback: YamlValue, keys: string[]): YamlValue {
    const value = yamlValue(...keys);
    return env[name] !== undefined ? env[name]! : value !== undefined ? value : fallback;
  }
  function string(name: string, fallback: string, ...keys: string[]): string {
    const value = raw(name, fallback, keys);
    if (typeof value !== 'string') throw new Error(`${name} must be a string`);
    return value;
  }
  function number(name: string, fallback: number, min: number, max: number, ...keys: string[]): number {
    const value = raw(name, fallback, keys);
    if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'string' && !value.trim()))
      throw new Error(`${name} must be an integer in ${min}..${max}`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
      throw new Error(`${name} must be an integer in ${min}..${max}`);
    return parsed;
  }
  function boolean(name: string, fallback: boolean, ...keys: string[]): boolean {
    const value = raw(name, fallback, keys);
    if (typeof value === 'boolean') return value;
    if (env[name] !== undefined && ['true', 'false', '1', '0'].includes(String(value)))
      return value === 'true' || value === '1';
    throw new Error(`${name} must be a boolean (true/false/1/0 in environment)`);
  }
  function filePath(name: string, fallback: string, ...keys: string[]): string {
    const value = string(name, fallback, ...keys);
    if (!value.trim()) throw new Error(`${name} must not be empty`);
    return path.resolve(env[name] !== undefined ? cwd : yamlValue(...keys) !== undefined ? base : cwd, value);
  }
  function list(name: string, fallback: string[], paths: boolean, ...keys: string[]): string[] {
    const value = raw(name, fallback, keys);
    const parts =
      typeof value === 'string'
        ? value
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
        : value;
    if (!Array.isArray(parts) || parts.some((part) => typeof part !== 'string' || !part.trim()))
      throw new Error(`${name} must be a list of strings`);
    return (parts as string[]).map((part) =>
      paths ? path.resolve(env[name] !== undefined ? cwd : yamlValue(...keys) !== undefined ? base : cwd, part) : part,
    );
  }
  return { env, cwd, base, yamlValue, string, number, boolean, filePath, list };
}

const presets = {
  public: { adminApi: false, users: false, worldWrites: false, dataWrites: false, diagnostics: false },
  sync: { adminApi: true, users: false, worldWrites: true, dataWrites: false, diagnostics: false },
  full: { adminApi: true, users: true, worldWrites: true, dataWrites: true, diagnostics: true },
};

export function loadServerConfig(options: ConfigurationOptions = {}) {
  const setting = settings(options);
  const { env, yamlValue, string, number, boolean, filePath, list } = setting;
  const profile = string('DEPLOYMENT_PROFILE', 'full', 'deployment.profile');
  if (!Object.hasOwn(presets, profile)) throw new Error('DEPLOYMENT_PROFILE must be public, sync, or full');
  const preset = presets[profile as keyof typeof presets];
  const features = {
    adminApi: boolean('ADMIN_API_ENABLED', preset.adminApi, 'features.adminApi'),
    users: boolean('USERS_ENABLED', preset.users, 'features.users'),
    worldWrites: boolean('WORLD_WRITES_ENABLED', preset.worldWrites, 'features.worldWrites'),
    dataWrites: boolean('DATA_WRITES_ENABLED', preset.dataWrites, 'features.dataWrites'),
    diagnostics: boolean('DIAGNOSTICS_ENABLED', preset.diagnostics, 'features.diagnostics'),
    contentReads: boolean('CONTENT_READS_ENABLED', false, 'features.contentReads'),
    contentWrites: boolean('CONTENT_WRITES_ENABLED', false, 'features.contentWrites'),
  };
  if (!features.adminApi) {
    features.worldWrites = false;
    features.dataWrites = false;
  }
  const authMode = string('AUTH_MODE', features.users ? 'users' : profile === 'sync' ? 'static' : 'none', 'auth.mode');
  if (!['none', 'static', 'users'].includes(authMode) || (authMode === 'users') !== features.users)
    throw new Error('AUTH_MODE conflicts with USERS_ENABLED');
  if ((features.adminApi || features.diagnostics) && authMode === 'none')
    throw new Error('Management and diagnostics require authentication');
  if (authMode === 'static' && !env.STATIC_API_TOKEN?.trim())
    throw new Error('STATIC_API_TOKEN is required for static authentication');
  if (features.contentWrites && (!features.contentReads || !features.adminApi || authMode === 'none'))
    throw new Error('contentWrites requires contentReads, adminApi and authentication');
  const staticRole = string('STATIC_TOKEN_ROLE', 'ci', 'auth.staticRole');
  if (!['viewer', 'ci', 'admin'].includes(staticRole))
    throw new Error('STATIC_TOKEN_ROLE must be viewer, ci, or admin');
  const driver = string('WORLD_STORAGE', 'local', 'worldStorage', 'storage.driver').toLowerCase();
  if (!['local', 's3'].includes(driver)) throw new Error('WORLD_STORAGE must be local or s3');
  if (
    driver === 's3' &&
    (!!env.S3_ACCESS_KEY_ID !== !!env.S3_SECRET_ACCESS_KEY || (env.S3_SESSION_TOKEN && !env.S3_ACCESS_KEY_ID))
  )
    throw new Error('S3 credentials must be supplied together');
  const dataDir = filePath('DATA_DIR', 'data', 'dataDir', 'data.dir');
  const mcVersion = string('MC_VERSION', '1.21.4', 'mcVersion', 'minecraft.version');
  const bucket = string('S3_BUCKET', '', 's3.bucket') || undefined;
  if (
    driver === 's3' &&
    !bucket &&
    yamlValue('storage.mounts.worlds') === undefined &&
    !env.STORAGE_MOUNT_WORLDS_BACKEND
  )
    throw new Error('S3_BUCKET is required when WORLD_STORAGE=s3');
  const origins = list('CORS_ORIGINS', ['*'], false, 'server.cors.origins');
  for (const origin of origins)
    if (origin !== '*') {
      try {
        if (new URL(origin).origin !== origin) throw new Error();
      } catch {
        throw new Error('CORS_ORIGINS must contain origins or *');
      }
    }
  // Check aliases even when a higher-priority environment value is present.
  yamlValue('databaseDir', 'database.dir');
  const legacyStorage = {
    driver: driver as 'local' | 's3',
    worldsDir: filePath('WORLDS_DIR', 'data/worlds', 'worldsDir', 'worlds.dir'),
    s3: {
      endpoint: string('S3_ENDPOINT', '', 's3.endpoint') || undefined,
      region: string('S3_REGION', 'auto', 's3.region'),
      bucket,
      prefix: string('S3_PREFIX', '', 's3.prefix'),
      forcePathStyle: boolean('S3_FORCE_PATH_STYLE', true, 's3.forcePathStyle'),
      credentials:
        env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
          ? {
              accessKeyId: env.S3_ACCESS_KEY_ID,
              secretAccessKey: env.S3_SECRET_ACCESS_KEY,
              sessionToken: env.S3_SESSION_TOKEN,
            }
          : undefined,
    },
  };
  const resolvedStorage = resolveStorage(setting, legacyStorage, features.contentReads, dataDir);
  const mediaPublicBaseUrl = string('MEDIA_PUBLIC_BASE_URL', '', 'content.mediaPublicBaseUrl');
  if (mediaPublicBaseUrl) createPublicObjectUrl(mediaPublicBaseUrl);
  return {
    deployment: { profile: profile as keyof typeof presets },
    features,
    content: { mediaPublicBaseUrl: mediaPublicBaseUrl || undefined },
    server: {
      port: number('PORT', 3300, 1, 65535, 'port', 'server.port'),
      cors: { origins },
      staticDir: string('STATIC_DIR', '', 'server.staticDir')
        ? filePath('STATIC_DIR', '', 'server.staticDir')
        : undefined,
    },
    auth: {
      mode: authMode as ServiceCapabilities['authMode'],
      staticRole: staticRole as CreatableRole,
      staticToken: env.STATIC_API_TOKEN,
      diagnosticsUploadToken: env.DIAGNOSTICS_UPLOAD_TOKEN,
      rootUsername: env.ROOT_USERNAME?.trim() || undefined,
      rootPassword: env.ROOT_PASSWORD || undefined,
    },
    database: {
      url: env.DATABASE_URL || undefined,
      dir: filePath('DATABASE_DIR', path.join(dataDir, 'users.pglite'), 'databaseDir', 'database.dir'),
    },
    storage: resolvedStorage,
    assets: { dirs: list('ASSETS_DIRS', ['data/assets'], true, 'assetsDirs', 'assets.dirs') },
    data: { dir: dataDir },
    minecraft: {
      version: mcVersion,
      dataVersion: string('MC_DATA_VERSION', mcVersion, 'mcDataVersion', 'minecraft.dataVersion'),
    },
    cache: {
      regionBytes: number('REGION_CACHE_BYTES', 256 * 1024 ** 2, 0, Number.MAX_SAFE_INTEGER, 'cache.regionBytes'),
      chunkNbtBytes: number(
        'CHUNK_NBT_CACHE_BYTES',
        128 * 1024 ** 2,
        0,
        Number.MAX_SAFE_INTEGER,
        'cache.chunkNbtBytes',
      ),
      textureBytes: number('TEXTURE_CACHE_BYTES', 32 * 1024 ** 2, 0, Number.MAX_SAFE_INTEGER, 'cache.textureBytes'),
      storageStatMs: number('STORAGE_STAT_CACHE_MS', 1000, 0, Number.MAX_SAFE_INTEGER, 'cache.storageStatMs'),
      storageListMs: number('STORAGE_LIST_CACHE_MS', 2000, 0, Number.MAX_SAFE_INTEGER, 'cache.storageListMs'),
      manifestMs: number('MANIFEST_CACHE_MS', 5000, 0, Number.MAX_SAFE_INTEGER, 'cache.manifestMs'),
      worldListMs: number('WORLD_LIST_CACHE_MS', 15000, 0, Number.MAX_SAFE_INTEGER, 'cache.worldListMs'),
      prewarm: boolean('CACHE_PREWARM', true, 'cache.prewarm'),
    },
    limits: {
      chunkReads: number('CHUNK_READ_CONCURRENCY', 8, 1, 1024, 'limits.chunkReads'),
      chunkQueue: number('CHUNK_READ_QUEUE', 64, 0, 65536, 'limits.chunkQueue'),
      chunkRequestBytes: number(
        'CHUNK_REQUEST_BYTES',
        64 * 1024,
        1,
        Number.MAX_SAFE_INTEGER,
        'limits.chunkRequestBytes',
      ),
      atlasRequestBytes: number(
        'ATLAS_REQUEST_BYTES',
        128 * 1024,
        1,
        Number.MAX_SAFE_INTEGER,
        'limits.atlasRequestBytes',
      ),
      diagnosticBytes: number('DIAGNOSTIC_BYTES', 2 * 1024 ** 2, 1, Number.MAX_SAFE_INTEGER, 'limits.diagnosticBytes'),
      uploadBytes: number('UPLOAD_BYTES', 256 * 1024 ** 2, 1, Number.MAX_SAFE_INTEGER, 'limits.uploadBytes'),
      atlasBuilds: number('ATLAS_BUILD_CONCURRENCY', 1, 1, 1024, 'limits.atlasBuilds'),
      atlasQueue: number('ATLAS_BUILD_QUEUE', 16, 0, 65536, 'limits.atlasQueue'),
    },
  };
}

export type ServerConfig = ReturnType<typeof loadServerConfig>;

export function readAdminConfig(
  options: ConfigurationOptions & Partial<DatabaseOptions> = {},
): DatabaseOptions & RootOptions {
  const { env, yamlValue, filePath } = settings(options);
  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
  if (
    !databaseUrl &&
    !options.databaseDir &&
    !env.DATABASE_DIR &&
    !env.DATA_DIR &&
    yamlValue('databaseDir', 'database.dir') === undefined &&
    yamlValue('dataDir', 'data.dir') === undefined
  )
    throw new Error(
      'Database mode requires DATABASE_URL, --database-dir, or an explicit database/data directory in the server configuration',
    );
  const dataDir = filePath('DATA_DIR', 'data', 'dataDir', 'data.dir');
  return {
    databaseUrl: databaseUrl || undefined,
    databaseDir: options.databaseDir
      ? path.resolve(options.cwd ?? process.cwd(), options.databaseDir)
      : filePath('DATABASE_DIR', path.join(dataDir, 'users.pglite'), 'databaseDir', 'database.dir'),
    rootUsername: env.ROOT_USERNAME?.trim() || undefined,
    rootPassword: env.ROOT_PASSWORD || undefined,
  };
}

export type StorageBackend = { driver: 'local'; root: string } | ({ driver: 's3' } & Omit<S3StorageOptions, 'prefix'>);

export interface StorageMount {
  backend: string;
  prefix: string;
}

function resolveStorage(
  setting: ReturnType<typeof settings>,
  legacy: { driver: 'local' | 's3'; worldsDir: string; s3: Omit<S3StorageOptions, 'bucket'> & { bucket?: string } },
  enabled: boolean,
  dataDir: string,
) {
  const { env, cwd, base, yamlValue } = setting;
  const backends: Record<string, StorageBackend> = {};
  const mounts: Record<'worlds' | 'content' | 'blobs', StorageMount> = {
    worlds: { backend: 'legacy', prefix: legacy.driver === 's3' ? (legacy.s3.prefix ?? '') : '' },
    content: { backend: 'auxiliary', prefix: 'metadata' },
    blobs: { backend: 'auxiliary', prefix: 'blobs' },
  };
  const legacyBackend = (): StorageBackend =>
    legacy.driver === 'local'
      ? { driver: 'local', root: legacy.worldsDir }
      : { ...legacy.s3, driver: 's3', bucket: legacy.s3.bucket! };
  backends.legacy = legacyBackend();
  backends.auxiliary = { driver: 'local', root: path.join(dataDir, 'content') };
  const object = (value: YamlValue | undefined): Record<string, YamlValue> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const definitions = object(yamlValue('storage.backends'));
  const names = new Set(Object.keys(definitions));
  for (const key of Object.keys(env)) {
    const match =
      /^STORAGE_BACKEND_([A-Z][A-Z0-9]*)_(DRIVER|ROOT|ENDPOINT|REGION|BUCKET|FORCE_PATH_STYLE|ACCESS_KEY_ID_ENV|SECRET_ACCESS_KEY_ENV|SESSION_TOKEN_ENV)$/.exec(
        key,
      );
    if (match) names.add(match[1].toLowerCase());
    else if (key.startsWith('STORAGE_BACKEND_')) throw new Error(`unknown storage environment field: ${key}`);
  }
  for (const name of names) {
    if (!/^[a-z][a-z0-9]*$/.test(name) || ['legacy', 'auxiliary', 'worldoverride'].includes(name))
      throw new Error(`invalid/reserved backend name: ${name}`);
    const definition = object(definitions[name]);
    const get = (field: string, suffix: string): string | undefined => {
      const value = env[`STORAGE_BACKEND_${name.toUpperCase()}_${suffix}`] ?? definition[field];
      if (value === undefined) return undefined;
      if (typeof value !== 'string' && typeof value !== 'boolean') throw new Error(`invalid backend ${name}.${field}`);
      return String(value);
    };
    const driver = get('driver', 'DRIVER');
    if (driver === 'local') {
      const root = get('root', 'ROOT');
      if (!root?.trim()) throw new Error(`backend ${name}.root required`);
      if (Object.keys(definition).some((key) => !['driver', 'root'].includes(key)))
        throw new Error(`invalid local backend fields: ${name}`);
      backends[name] = {
        driver,
        root: path.resolve(env[`STORAGE_BACKEND_${name.toUpperCase()}_ROOT`] !== undefined ? cwd : base, root),
      };
    } else if (driver === 's3') {
      if (definition.root !== undefined) throw new Error(`S3 backend ${name} cannot have root`);
      const bucket = get('bucket', 'BUCKET');
      if (!bucket) throw new Error(`backend ${name}.bucket required`);
      const credential = (field: string, suffix: string) => {
        const reference = get(field, suffix);
        if (reference === undefined) return undefined;
        if (!/^[A-Z_][A-Z0-9_]*$/.test(reference) || !env[reference])
          throw new Error(`missing credential environment reference for ${name}.${field}`);
        return env[reference];
      };
      const accessKeyId = credential('accessKeyIdEnv', 'ACCESS_KEY_ID_ENV');
      const secretAccessKey = credential('secretAccessKeyEnv', 'SECRET_ACCESS_KEY_ENV');
      const sessionToken = credential('sessionTokenEnv', 'SESSION_TOKEN_ENV');
      if (!!accessKeyId !== !!secretAccessKey || (sessionToken && !accessKeyId))
        throw new Error(`backend ${name} credentials must be supplied together`);
      const force = get('forcePathStyle', 'FORCE_PATH_STYLE') ?? 'true';
      if (!['true', 'false', '1', '0'].includes(force)) throw new Error(`invalid backend ${name}.forcePathStyle`);
      backends[name] = {
        driver,
        bucket,
        endpoint: get('endpoint', 'ENDPOINT'),
        region: get('region', 'REGION') ?? 'auto',
        forcePathStyle: ['true', '1'].includes(force),
        credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey, sessionToken } : undefined,
      };
    } else throw new Error(`backend ${name}.driver must be local or s3`);
  }
  for (const backend of Object.values(backends))
    if (backend.driver === 's3' && backend.endpoint) {
      const url = new URL(backend.endpoint);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new Error('S3 endpoint must be HTTP(S) without credentials, query or fragment');
    }
  const cleanPrefix = (value: string) => {
    if (value.includes('\\') || value.startsWith('/') || value.split('/').some((part) => part === '..' || part === '.'))
      throw new Error('invalid mount prefix');
    return value.split('/').filter(Boolean).join('/');
  };
  for (const key of Object.keys(env))
    if (key.startsWith('STORAGE_MOUNT_') && !/^STORAGE_MOUNT_(WORLDS|CONTENT|BLOBS)_(BACKEND|PREFIX)$/.test(key))
      throw new Error(`unknown storage environment field: ${key}`);
  for (const name of ['worlds', 'content', 'blobs'] as const) {
    const definition = object(yamlValue(`storage.mounts.${name}`));
    const backend = env[`STORAGE_MOUNT_${name.toUpperCase()}_BACKEND`] ?? definition.backend;
    const prefix = env[`STORAGE_MOUNT_${name.toUpperCase()}_PREFIX`] ?? definition.prefix;
    if (backend !== undefined || prefix !== undefined)
      mounts[name] = { backend: String(backend ?? mounts[name].backend), prefix: cleanPrefix(String(prefix ?? '')) };
    if (!backends[mounts[name].backend]) throw new Error(`unknown backend for ${name}`);
    mounts[name].prefix = cleanPrefix(mounts[name].prefix);
  }
  const legacyEnv = [
    'WORLD_STORAGE',
    'WORLDS_DIR',
    'S3_ENDPOINT',
    'S3_REGION',
    'S3_BUCKET',
    'S3_PREFIX',
    'S3_FORCE_PATH_STYLE',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'S3_SESSION_TOKEN',
  ].some((key) => env[key] !== undefined);
  const explicitWorld =
    yamlValue('storage.mounts.worlds') !== undefined ||
    env.STORAGE_MOUNT_WORLDS_BACKEND !== undefined ||
    env.STORAGE_MOUNT_WORLDS_PREFIX !== undefined;
  const yamlLegacy = ['worldStorage', 'storage.driver', 'worldsDir', 'worlds.dir', 's3'].some(
    (key) => yamlValue(key) !== undefined,
  );
  const currentMount = mounts.worlds;
  const currentBackend = backends[currentMount.backend];
  const sameEndpoint = (a?: string, b?: string) =>
    (a ? new URL(a).href : undefined) === (b ? new URL(b).href : undefined);
  const verifyLegacy = (has: (envKey: string, ...yamlKeys: string[]) => boolean) => {
    const conflict = (field: string) => {
      throw new Error(`conflicting configuration fields: ${field} and storage.mounts.worlds`);
    };
    if (has('WORLD_STORAGE', 'worldStorage', 'storage.driver') && currentBackend.driver !== legacy.driver)
      conflict('WORLD_STORAGE');
    if (
      has('WORLDS_DIR', 'worldsDir', 'worlds.dir') &&
      (currentBackend.driver !== 'local' || path.resolve(currentBackend.root, currentMount.prefix) !== legacy.worldsDir)
    )
      conflict('WORLDS_DIR');
    if (currentBackend.driver === 's3') {
      if (has('S3_BUCKET', 's3.bucket') && currentBackend.bucket !== legacy.s3.bucket) conflict('S3_BUCKET');
      if (has('S3_ENDPOINT', 's3.endpoint') && !sameEndpoint(currentBackend.endpoint, legacy.s3.endpoint))
        conflict('S3_ENDPOINT');
      if (has('S3_REGION', 's3.region') && currentBackend.region !== legacy.s3.region) conflict('S3_REGION');
      if (has('S3_PREFIX', 's3.prefix') && currentMount.prefix !== cleanPrefix(legacy.s3.prefix ?? ''))
        conflict('S3_PREFIX');
      if (has('S3_FORCE_PATH_STYLE', 's3.forcePathStyle') && currentBackend.forcePathStyle !== legacy.s3.forcePathStyle)
        conflict('S3_FORCE_PATH_STYLE');
      if (
        has('S3_ACCESS_KEY_ID') &&
        JSON.stringify(currentBackend.credentials) !== JSON.stringify(legacy.s3.credentials)
      )
        conflict('S3_ACCESS_KEY_ID');
    }
  };
  const namedEnvForWorld = Object.keys(env).some(
    (key) =>
      key.startsWith(`STORAGE_BACKEND_${currentMount.backend.toUpperCase()}_`) ||
      key.startsWith('STORAGE_MOUNT_WORLDS_'),
  );
  if (explicitWorld && yamlLegacy && !legacyEnv && !namedEnvForWorld)
    verifyLegacy((_key, ...keys) => keys.some((key) => yamlValue(key) !== undefined));
  if (legacyEnv && explicitWorld && namedEnvForWorld) verifyLegacy((key) => env[key] !== undefined);
  if (legacyEnv && explicitWorld && !namedEnvForWorld) {
    const current = currentBackend;
    const driver = env.WORLD_STORAGE ?? current.driver;
    backends.worldoverride =
      driver === 'local'
        ? {
            driver: 'local',
            root: env.WORLDS_DIR
              ? legacy.worldsDir
              : current.driver === 'local'
                ? path.resolve(current.root, currentMount.prefix)
                : legacy.worldsDir,
          }
        : {
            ...(current.driver === 's3' ? current : legacy.s3),
            driver: 's3',
            bucket: env.S3_BUCKET ?? (current.driver === 's3' ? current.bucket : legacy.s3.bucket!),
            ...(env.S3_ENDPOINT !== undefined ? { endpoint: legacy.s3.endpoint } : {}),
            ...(env.S3_REGION !== undefined ? { region: legacy.s3.region } : {}),
            ...(env.S3_FORCE_PATH_STYLE !== undefined ? { forcePathStyle: legacy.s3.forcePathStyle } : {}),
            ...(env.S3_ACCESS_KEY_ID !== undefined ? { credentials: legacy.s3.credentials } : {}),
          };
    if (backends.worldoverride.driver === 's3' && !backends.worldoverride.bucket)
      throw new Error('S3_BUCKET is required for the worlds override');
    mounts.worlds = {
      backend: 'worldoverride',
      prefix: driver === 's3' ? cleanPrefix(env.S3_PREFIX ?? currentMount.prefix) : '',
    };
  }
  const effectivePath = (root: string): string => {
    try {
      return fs.realpathSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(root);
      return parent === root ? root : path.join(effectivePath(parent), path.basename(root));
    }
  };
  const locations = (['worlds', ...(enabled ? ['content', 'blobs'] : [])] as (keyof typeof mounts)[]).map((name) => {
    const mount = mounts[name],
      backend = backends[mount.backend];
    return {
      name,
      identity:
        backend.driver === 'local'
          ? 'local'
          : `s3:${new URL(backend.endpoint ?? `https://s3.${backend.region ?? 'auto'}.amazonaws.com`).href}:${backend.bucket}`,
      prefix: backend.driver === 'local' ? effectivePath(path.resolve(backend.root, mount.prefix)) : mount.prefix,
    };
  });
  for (let a = 0; a < locations.length; a++)
    for (let b = a + 1; b < locations.length; b++) {
      const x = locations[a],
        y = locations[b];
      if (
        x.identity === y.identity &&
        (x.prefix === y.prefix ||
          !x.prefix ||
          !y.prefix ||
          x.prefix.startsWith(y.prefix + '/') ||
          y.prefix.startsWith(x.prefix + '/'))
      )
        throw new Error(`overlapping storage mounts: ${x.name}, ${y.name}`);
    }
  for (const backend of Object.values(backends))
    if (backend.driver === 's3') delete (backend as S3StorageOptions).prefix;
  const worldBackend = backends[mounts.worlds.backend];
  return {
    driver: worldBackend.driver,
    worldsDir:
      worldBackend.driver === 'local' ? path.resolve(worldBackend.root, mounts.worlds.prefix) : legacy.worldsDir,
    s3: worldBackend.driver === 's3' ? { ...worldBackend, prefix: mounts.worlds.prefix } : legacy.s3,
    backends,
    mounts,
  };
}
