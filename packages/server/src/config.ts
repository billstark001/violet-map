import path from 'node:path';
import { findYamlConfig, type YamlValue } from './configYaml.js';

const yaml = findYamlConfig();
const yamlBase = yaml ? path.dirname(yaml.file) : process.cwd();

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
  const env = process.env[envName];
  if (env !== undefined) return env;
  const value = yamlValue(...yamlKeys);
  return value === undefined ? fallback : String(value);
}

function numberConfig(envName: string, fallback: number, ...yamlKeys: string[]): number {
  const raw = process.env[envName] ?? yamlValue(...yamlKeys);
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function booleanConfig(envName: string, fallback: boolean, ...yamlKeys: string[]): boolean {
  const raw = process.env[envName] ?? yamlValue(...yamlKeys);
  if (raw === undefined) return fallback;
  if (typeof raw === 'boolean') return raw;
  return String(raw) !== 'false';
}

function pathConfig(envName: string, fallback: string, ...yamlKeys: string[]): string {
  const env = process.env[envName];
  if (env !== undefined) return path.resolve(env);
  const value = yamlValue(...yamlKeys);
  if (value === undefined) return path.resolve(fallback);
  return path.resolve(yamlBase, String(value));
}

function stringListConfig(envName: string, fallback: string[], ...yamlKeys: string[]): string[] {
  const env = process.env[envName];
  if (env !== undefined)
    return env
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => path.resolve(p));
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

const mcVersion = stringConfig('MC_VERSION', '1.21.4', 'mcVersion', 'minecraft.version');
const worldStorage = stringConfig('WORLD_STORAGE', 'local', 'worldStorage', 'storage.driver').toLowerCase();
if (worldStorage !== 'local' && worldStorage !== 's3') {
  throw new Error(`WORLD_STORAGE must be local or s3; received ${worldStorage}`);
}
const dataDir = pathConfig('DATA_DIR', 'data', 'dataDir', 'data.dir');
const databaseDirOverride = process.env.DATABASE_DIR ?? yamlValue('databaseDir', 'database.dir');
const databaseDir =
  databaseDirOverride === undefined
    ? path.join(dataDir, 'users.pglite')
    : path.resolve(
        process.env.DATABASE_DIR ? String(databaseDirOverride) : path.resolve(yamlBase, String(databaseDirOverride)),
      );

export const config = {
  port: numberConfig('PORT', 3300, 'port', 'server.port'),
  /** 世界目录：<worldsDir>/<world>/region 等 */
  worldsDir: pathConfig('WORLDS_DIR', 'data/worlds', 'worldsDir', 'worlds.dir'),
  worldStorage,
  s3: {
    endpoint: stringConfig('S3_ENDPOINT', '', 's3.endpoint') || undefined,
    region: stringConfig('S3_REGION', 'auto', 's3.region'),
    bucket: stringConfig('S3_BUCKET', '', 's3.bucket') || undefined,
    prefix: stringConfig('S3_PREFIX', '', 's3.prefix'),
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: booleanConfig('S3_FORCE_PATH_STYLE', true, 's3.forcePathStyle'),
  },
  /** Set DATABASE_URL to use PostgreSQL; otherwise PGlite persists below DATA_DIR. */
  databaseUrl: process.env.DATABASE_URL || undefined,
  databaseDir,
  /** Root is virtual and exists only when both values are configured. */
  rootUsername: process.env.ROOT_USERNAME?.trim() || undefined,
  rootPassword: process.env.ROOT_PASSWORD || undefined,
  /** 资源目录列表（后者覆盖前者），每个目录下为 <namespace>/blockstates|models|textures */
  // Tracked renderer defaults are loaded before an extracted/user resource
  // pack, allowing packs to replace any registration or model normally.
  assetsDirs: stringListConfig('ASSETS_DIRS', ['data-defaults/assets', 'data/assets'], 'assetsDirs', 'assets.dirs'),
  dataDir,
  mcVersion,
  mcDataVersion: stringConfig('MC_DATA_VERSION', mcVersion, 'mcDataVersion', 'minecraft.dataVersion'),
};
