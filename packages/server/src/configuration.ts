import type { S3StorageOptions } from '@violet-map/storage/types';
import fs from 'node:fs';
import path from 'node:path';
import type { YamlValue } from './configYaml.js';
import { configurationSettings, type ConfigurationOptions } from './configurationSettings.js';

import type { CreatableRole, ServiceCapabilities } from '@violet-map/core/contracts';
import { resourceConfiguration } from './resourceConfiguration.js';

export { readAdminConfig } from './adminConfiguration.js';
export type { ConfigurationOptions } from './configurationSettings.js';

const presets = {
  public: { adminApi: false, users: false, worldWrites: false, dataWrites: false, diagnostics: false },
  sync: { adminApi: true, users: false, worldWrites: true, dataWrites: false, diagnostics: false },
  full: { adminApi: true, users: true, worldWrites: true, dataWrites: true, diagnostics: true },
};

export function loadServerConfig(options: ConfigurationOptions = {}) {
  const setting = configurationSettings({ ...options, env: options.env ?? process.env });
  const { env, yamlValue, string, number, boolean, filePath, list } = setting;
  const resources = resourceConfiguration(setting);
  const profile = string('DEPLOYMENT_PROFILE', 'full', 'deployment.profile');
  if (!Object.hasOwn(presets, profile)) throw new Error('DEPLOYMENT_PROFILE must be public, sync, or full');
  const preset = presets[profile as keyof typeof presets];
  const features = {
    adminApi: boolean('ADMIN_API_ENABLED', preset.adminApi, 'features.adminApi'),
    users: boolean('USERS_ENABLED', preset.users, 'features.users'),
    worldReads: boolean('WORLD_READS_ENABLED', resources.delivery.mode === 'server', 'features.worldReads'),
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
  if (setting.env.CACHE_PREWARM !== undefined || setting.yamlValue('cache.prewarm') !== undefined)
    throw new Error('CACHE_PREWARM/cache.prewarm was removed; use resources prepare');
  const resolvedStorage = resolveStorage(
    setting,
    legacyStorage,
    features.contentReads,
    dataDir,
    resources,
    resources.delivery.mode === 'server' ||
      resources.roles.includes('publish') ||
      features.worldReads ||
      features.worldWrites ||
      features.dataWrites ||
      features.contentReads,
  );
  if (env.MEDIA_PUBLIC_BASE_URL !== undefined || yamlValue('content.mediaPublicBaseUrl') !== undefined)
    throw new Error('MEDIA_PUBLIC_BASE_URL/content.mediaPublicBaseUrl was removed; configure resources.delivery');
  for (const mount of [resources.cache.sharedMount, resources.delivery.targetMount, resources.publication.storeMount])
    if (mount && !resolvedStorage.backends[mount.backend]) throw new Error('unknown resource storage backend');
  return {
    deployment: { profile: profile as keyof typeof presets },
    features,
    resources,
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
      mediaImports: number('MEDIA_IMPORT_CONCURRENCY', 1, 1, 1024, 'limits.mediaImports'),
      mediaQueue: number('MEDIA_IMPORT_QUEUE', 8, 0, 65536, 'limits.mediaQueue'),
      contentMutations: number('CONTENT_MUTATION_CONCURRENCY', 1, 1, 1024, 'limits.contentMutations'),
      contentQueue: number('CONTENT_MUTATION_QUEUE', 32, 0, 65536, 'limits.contentQueue'),
    },
  };
}

export type ServerConfig = ReturnType<typeof loadServerConfig>;

export type StorageBackend =
  | { driver: 'server'; url: string; token: string }
  | { driver: 'local'; root: string }
  | ({ driver: 's3' } & Omit<S3StorageOptions, 'prefix'>);

export interface StorageMount {
  backend: string;
  prefix: string;
}

function resolveStorage(
  setting: ReturnType<typeof configurationSettings>,
  legacy: { driver: 'local' | 's3'; worldsDir: string; s3: Omit<S3StorageOptions, 'bucket'> & { bucket?: string } },
  enabled: boolean,
  dataDir: string,
  resources: import('./resourceConfiguration.js').ResourceConfiguration,
  worldsEnabled: boolean,
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
      /^STORAGE_BACKEND_([A-Z][A-Z0-9]*)_(DRIVER|ROOT|ENDPOINT|REGION|BUCKET|FORCE_PATH_STYLE|ACCESS_KEY_ID_ENV|SECRET_ACCESS_KEY_ENV|SESSION_TOKEN_ENV|URL|TOKEN_ENV)$/.exec(
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
    } else if (driver === 'server') {
      if (Object.keys(definition).some((key) => !['driver', 'url', 'tokenEnv'].includes(key)))
        throw new Error('invalid remote world backend fields');
      const url = get('url', 'URL'),
        reference = get('tokenEnv', 'TOKEN_ENV');
      if (!url || !reference || !/^[A-Z_][A-Z0-9_]*$/.test(reference) || !env[reference])
        throw new Error('remote world source requires URL and credential environment reference');
      const parsed = new URL(url);
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      )
        throw new Error('invalid remote world URL');
      backends[name] = { driver: 'server', url: parsed.href, token: env[reference]! };
    } else throw new Error(`backend ${name}.driver must be local, s3 or server`);
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
  const locations = (
    [...(worldsEnabled ? ['worlds'] : []), ...(enabled ? ['content', 'blobs'] : [])] as (keyof typeof mounts)[]
  ).map((name) => {
    const mount = mounts[name],
      backend = backends[mount.backend];
    return {
      name,
      identity:
        backend.driver === 'local'
          ? 'local'
          : backend.driver === 'server'
            ? `server:${backend.url}`
            : `s3:${new URL(backend.endpoint ?? `https://s3.${backend.region ?? 'auto'}.amazonaws.com`).href}:${backend.bucket}`,
      prefix: backend.driver === 'local' ? effectivePath(path.resolve(backend.root, mount.prefix)) : mount.prefix,
    };
  });
  for (const name of ['content', 'blobs'] as const)
    if (enabled && backends[mounts[name].backend].driver === 'server')
      throw new Error('remote world protocol is only a source backend');
  const extras: [string, StorageMount][] = [];
  for (const [name, mount] of [
    ['resourceTarget', resources.delivery.targetMount],
    ['publicationStore', resources.publication.storeMount],
    ['sharedCache', resources.cache.sharedBytes > 0 ? resources.cache.sharedMount : null],
  ] as const)
    if (mount) extras.push([name, mount]);
  for (const [name, mount] of extras) {
    const backend = backends[mount.backend];
    if (!backend) throw new Error(`unknown backend for ${name}`);
    if (backend.driver === 'server')
      throw new Error('resource authority/cache mounts require conditional object storage');
    locations.push({
      name: name as keyof typeof mounts,
      identity:
        backend.driver === 'local'
          ? 'local'
          : `s3:${new URL(backend.endpoint ?? `https://s3.${backend.region ?? 'auto'}.amazonaws.com`).href}:${backend.bucket}`,
      prefix: backend.driver === 'local' ? effectivePath(path.resolve(backend.root, mount.prefix)) : mount.prefix,
    });
  }
  const dynamic = resources.delivery.mode === 'server' || resources.roles.includes('publish');
  const directories: [string, string][] = [];
  if (dynamic && resources.cache.local && resources.cache.local.bytes > 0)
    directories.push(['resourceLocal', resources.cache.local.directory]);
  if (dynamic && resources.cache.index.driver === 'sqlite')
    directories.push(['resourceIndex', resources.cache.index.path]);
  if (dynamic && resources.work.workspace) directories.push(['resourceWorkspace', resources.work.workspace.directory]);
  for (const [name, directory] of directories)
    locations.push({ name: name as keyof typeof mounts, identity: 'local', prefix: effectivePath(directory) });
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
