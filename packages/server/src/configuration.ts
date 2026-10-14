import path from 'node:path';
import { findYamlConfig, type YamlValue } from './configYaml.js';

import type { DatabaseOptions } from './db/connection.js';
import type { RootOptions } from './users.js';

export interface ConfigurationOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  configFile?: string;
}

function settings(options: ConfigurationOptions) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const yaml = findYamlConfig({ env, cwd, file: options.configFile });
  const yamlBase = yaml ? path.dirname(yaml.file) : cwd;

  function yamlValue(...keys: string[]): YamlValue | undefined {
    for (const key of keys) {
      const parts = key.split('.');
      let value: YamlValue | undefined = yaml?.data;
      for (const part of parts) {
        if (!value || Array.isArray(value) || typeof value !== 'object') {
          value = undefined;
          break;
        }
        value = value[part];
      }
      if (value !== undefined) return value;
    }
    return undefined;
  }

  function stringConfig(envName: string, fallback: string, ...yamlKeys: string[]): string {
    const override = env[envName];
    if (override !== undefined) return override;
    const value = yamlValue(...yamlKeys);
    return value === undefined ? fallback : String(value);
  }

  function numberConfig(envName: string, fallback: number, ...yamlKeys: string[]): number {
    const raw = env[envName] ?? yamlValue(...yamlKeys);
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  }

  function booleanConfig(envName: string, fallback: boolean, ...yamlKeys: string[]): boolean {
    const raw = env[envName] ?? yamlValue(...yamlKeys);
    if (raw === undefined) return fallback;
    if (typeof raw === 'boolean') return raw;
    return String(raw) !== 'false';
  }

  function pathConfig(envName: string, fallback: string, ...yamlKeys: string[]): string {
    const override = env[envName];
    if (override !== undefined) return path.resolve(cwd, override);
    const value = yamlValue(...yamlKeys);
    if (value === undefined) return path.resolve(cwd, fallback);
    return path.resolve(yamlBase, String(value));
  }

  function stringListConfig(envName: string, fallback: string[], ...yamlKeys: string[]): string[] {
    const override = env[envName];
    if (override !== undefined)
      return override
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => path.resolve(cwd, p));
    const value = yamlValue(...yamlKeys);
    const values = Array.isArray(value)
      ? value.map(String)
      : typeof value === 'string'
        ? value
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean)
        : fallback;
    return values.map((p) => path.resolve(yamlBase, p));
  }

  return { env, cwd, yamlValue, stringConfig, numberConfig, booleanConfig, pathConfig, stringListConfig };
}

export function loadServerConfig(options: ConfigurationOptions = {}) {
  const { env, stringConfig, numberConfig, booleanConfig, pathConfig, stringListConfig } = settings(options);
  const mcVersion = stringConfig('MC_VERSION', '1.21.4', 'mcVersion', 'minecraft.version');
  const worldStorage = stringConfig('WORLD_STORAGE', 'local', 'worldStorage', 'storage.driver').toLowerCase();
  if (worldStorage !== 'local' && worldStorage !== 's3') {
    throw new Error(`WORLD_STORAGE must be local or s3; received ${worldStorage}`);
  }
  if (
    worldStorage === 's3' &&
    (!!env.S3_ACCESS_KEY_ID !== !!env.S3_SECRET_ACCESS_KEY || (env.S3_SESSION_TOKEN && !env.S3_ACCESS_KEY_ID))
  )
    throw new Error('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be supplied together');
  const dataDir = pathConfig('DATA_DIR', 'data', 'dataDir', 'data.dir');
  const databaseDir = pathConfig('DATABASE_DIR', path.join(dataDir, 'users.pglite'), 'databaseDir', 'database.dir');

  return {
    port: numberConfig('PORT', 3300, 'port', 'server.port'),
    /** 世界目录：<worldsDir>/<world>/region 等 */
    worldsDir: pathConfig('WORLDS_DIR', 'data/worlds', 'worldsDir', 'worlds.dir'),
    worldStorage,
    s3: {
      endpoint: stringConfig('S3_ENDPOINT', '', 's3.endpoint') || undefined,
      region: stringConfig('S3_REGION', 'auto', 's3.region'),
      bucket: stringConfig('S3_BUCKET', '', 's3.bucket') || undefined,
      prefix: stringConfig('S3_PREFIX', '', 's3.prefix'),
      credentials:
        env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
          ? {
              accessKeyId: env.S3_ACCESS_KEY_ID,
              secretAccessKey: env.S3_SECRET_ACCESS_KEY,
              sessionToken: env.S3_SESSION_TOKEN,
            }
          : undefined,
      forcePathStyle: booleanConfig('S3_FORCE_PATH_STYLE', true, 's3.forcePathStyle'),
    },
    /** Set DATABASE_URL to use PostgreSQL; otherwise PGlite persists below DATA_DIR. */
    databaseUrl: env.DATABASE_URL || undefined,
    databaseDir,
    /** Root is virtual and exists only when both values are configured. */
    rootUsername: env.ROOT_USERNAME?.trim() || undefined,
    rootPassword: env.ROOT_PASSWORD || undefined,
    /** 资源目录列表（后者覆盖前者），每个目录下为 <namespace>/blockstates|models|textures */
    // Tracked renderer defaults are loaded before an extracted/user resource
    // pack, allowing packs to replace any registration or model normally.
    assetsDirs: stringListConfig('ASSETS_DIRS', ['data-defaults/assets', 'data/assets'], 'assetsDirs', 'assets.dirs'),
    dataDir,
    mcVersion,
    mcDataVersion: stringConfig('MC_DATA_VERSION', mcVersion, 'mcDataVersion', 'minecraft.dataVersion'),
  };
}

export function readAdminConfig(
  options: ConfigurationOptions & Partial<DatabaseOptions> = {},
): DatabaseOptions & RootOptions {
  const { env, yamlValue, pathConfig } = settings(options);
  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
  const directorySet =
    options.databaseDir ||
    env.DATABASE_DIR ||
    env.DATA_DIR ||
    yamlValue('databaseDir', 'database.dir', 'dataDir', 'data.dir');
  if (!databaseUrl && !directorySet)
    throw new Error(
      'Database mode requires DATABASE_URL, --database-dir, or an explicit database/data directory in the server configuration',
    );
  const dataDir = pathConfig('DATA_DIR', 'data', 'dataDir', 'data.dir');
  return {
    databaseUrl: databaseUrl || undefined,
    databaseDir:
      options.databaseDir ??
      pathConfig('DATABASE_DIR', path.join(dataDir, 'users.pglite'), 'databaseDir', 'database.dir'),
    rootUsername: env.ROOT_USERNAME?.trim() || undefined,
    rootPassword: env.ROOT_PASSWORD || undefined,
  };
}
