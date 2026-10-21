import path from 'node:path';
import { findYamlConfig, type YamlValue } from './configYaml.js';

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
  'features.worldReads',
  'features.worldWrites',
  'features.dataWrites',
  'features.diagnostics',
  'features.contentReads',
  'features.contentWrites',
  'auth.mode',
  'auth.staticRole',
  'cache.storageStatMs',
  'cache.storageListMs',
  'limits.chunkRequestBytes',
  'limits.atlasRequestBytes',
  'limits.diagnosticBytes',
  'limits.uploadBytes',
  'limits.mediaImports',
  'limits.mediaQueue',
  'limits.contentMutations',
  'limits.contentQueue',
];

export function configurationSettings(options: ConfigurationOptions & { env: NodeJS.ProcessEnv }) {
  const env = options.env;
  const cwd = options.cwd ?? process.cwd();
  const yaml = findYamlConfig({ env, cwd, file: options.configFile });
  const base = yaml ? path.dirname(yaml.file) : cwd;
  function validate(value: YamlValue, prefix = '') {
    if (!value || Array.isArray(value) || typeof value !== 'object')
      throw new Error(`configuration ${prefix || 'root'} must be a mapping`);
    for (const [key, child] of Object.entries(value)) {
      const field = prefix ? `${prefix}.${key}` : key;
      if (field === 'resources') continue;
      const namedBackend =
        /^storage\.backends\.[a-z][a-z0-9]*\.(driver|root|endpoint|region|bucket|forcePathStyle|accessKeyIdEnv|secretAccessKeyEnv|sessionTokenEnv)$/.test(
          field,
        );
      const namedMount = /^storage\.mounts\.(worlds|content|blobs)\.(backend|prefix)$/.test(field);
      if (fields.includes(field) || namedBackend || namedMount) {
        const isBoolean =
          field.startsWith('features.') || field === 's3.forcePathStyle' || field.endsWith('.forcePathStyle');
        const isNumber =
          ['port', 'server.port'].includes(field) || field.startsWith('limits.') || field.startsWith('cache.');
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
