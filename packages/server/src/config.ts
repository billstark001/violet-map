import fs from 'node:fs';
import path from 'node:path';

type YamlValue = string | number | boolean | string[] | YamlObject;
interface YamlObject {
  [key: string]: YamlValue;
}
type YamlConfig = YamlObject;

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if ((ch === '"' || ch === "'") && line[i - 1] !== '\\') quote = quote === ch ? null : quote ?? ch;
    if (ch === '#' && !quote) return line.slice(0, i);
  }
  return line;
}

function parseScalar(raw: string): YamlValue {
  const value = raw.trim();
  if (!value) return '';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).split(',').map((part) => String(parseScalar(part))).filter(Boolean);
  }
  return value;
}

function parseSimpleYaml(text: string): YamlConfig {
  const root: YamlConfig = {};
  let parentKey: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const trimmed = line.trim();
    if (indent === 0) {
      const sep = trimmed.indexOf(':');
      if (sep < 0) continue;
      const key = trimmed.slice(0, sep).trim();
      const rest = trimmed.slice(sep + 1).trim();
      if (!rest) {
        root[key] = {};
        parentKey = key;
      } else {
        root[key] = parseScalar(rest);
        parentKey = key;
      }
      continue;
    }
    if (!parentKey) continue;
    if (trimmed.startsWith('- ')) {
      const current = root[parentKey];
      const list = Array.isArray(current) ? current : [];
      list.push(String(parseScalar(trimmed.slice(2))));
      root[parentKey] = list;
      continue;
    }
    const parent = root[parentKey];
    if (!parent || Array.isArray(parent) || typeof parent !== 'object') continue;
    const sep = trimmed.indexOf(':');
    if (sep < 0) continue;
    const key = trimmed.slice(0, sep).trim();
    const rest = trimmed.slice(sep + 1).trim();
    parent[key] = rest ? parseScalar(rest) : {};
  }
  return root;
}

function findYamlConfig(): { file: string; data: YamlConfig } | null {
  const explicit = process.env.VIOLET_MAP_CONFIG;
  if (explicit) {
    const file = path.resolve(explicit);
    try {
      if (!fs.statSync(file).isFile()) throw new Error('not a file');
      return { file, data: parseSimpleYaml(fs.readFileSync(file, 'utf8')) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to load YAML config ${file}: ${message}`);
    }
  }
  const candidates = [path.resolve('violet-map.yaml'), path.resolve('violet-map.yml')];
  for (const file of candidates) {
    try {
      if (!fs.statSync(file).isFile()) continue;
      return { file, data: parseSimpleYaml(fs.readFileSync(file, 'utf8')) };
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

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
  if (env !== undefined) return env.split(',').map((p) => p.trim()).filter(Boolean).map((p) => path.resolve(p));
  const value = yamlValue(...yamlKeys);
  const values = Array.isArray(value)
    ? value.map(String)
    : typeof value === 'string'
      ? value.split(',').map((p) => p.trim()).filter(Boolean)
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
const databaseDir = databaseDirOverride === undefined
  ? path.join(dataDir, 'users.pglite')
  : path.resolve(process.env.DATABASE_DIR ? String(databaseDirOverride) : path.resolve(yamlBase, String(databaseDirOverride)));

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
