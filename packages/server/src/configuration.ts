import path from 'node:path';
import { findYamlConfig, type YamlValue } from './configYaml.js';
import type { DatabaseOptions } from './db/connection.js';
import type { RootOptions } from './users.js';
import type { CreatableRole, ServiceCapabilities } from '@violet-map/core/contracts';

export interface ConfigurationOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  configFile?: string;
}
const fields = [
  'deployment.profile',
  'server.port',
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
      if (fields.includes(field)) {
        const isBoolean = field.startsWith('features.') || ['s3.forcePathStyle', 'cache.prewarm'].includes(field);
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
      if (!fields.some((allowed) => allowed.startsWith(`${field}.`)))
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
  return { env, cwd, yamlValue, string, number, boolean, filePath, list };
}
const presets = {
  public: { adminApi: false, users: false, worldWrites: false, dataWrites: false, diagnostics: false },
  sync: { adminApi: true, users: false, worldWrites: true, dataWrites: false, diagnostics: false },
  full: { adminApi: true, users: true, worldWrites: true, dataWrites: true, diagnostics: true },
};
export function loadServerConfig(options: ConfigurationOptions = {}) {
  const { env, yamlValue, string, number, boolean, filePath, list } = settings(options);
  const profile = string('DEPLOYMENT_PROFILE', 'full', 'deployment.profile');
  if (!Object.hasOwn(presets, profile)) throw new Error('DEPLOYMENT_PROFILE must be public, sync, or full');
  const preset = presets[profile as keyof typeof presets];
  const features = {
    adminApi: boolean('ADMIN_API_ENABLED', preset.adminApi, 'features.adminApi'),
    users: boolean('USERS_ENABLED', preset.users, 'features.users'),
    worldWrites: boolean('WORLD_WRITES_ENABLED', preset.worldWrites, 'features.worldWrites'),
    dataWrites: boolean('DATA_WRITES_ENABLED', preset.dataWrites, 'features.dataWrites'),
    diagnostics: boolean('DIAGNOSTICS_ENABLED', preset.diagnostics, 'features.diagnostics'),
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
  if (driver === 's3' && !bucket) throw new Error('S3_BUCKET is required when WORLD_STORAGE=s3');
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
  return {
    deployment: { profile: profile as keyof typeof presets },
    features,
    server: { port: number('PORT', 3300, 1, 65535, 'port', 'server.port'), cors: { origins } },
    auth: {
      mode: authMode as ServiceCapabilities['authMode'],
      staticRole: staticRole as CreatableRole,
      staticToken: env.STATIC_API_TOKEN,
      rootUsername: env.ROOT_USERNAME?.trim() || undefined,
      rootPassword: env.ROOT_PASSWORD || undefined,
    },
    database: {
      url: env.DATABASE_URL || undefined,
      dir: filePath('DATABASE_DIR', path.join(dataDir, 'users.pglite'), 'databaseDir', 'database.dir'),
    },
    storage: {
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
    },
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
