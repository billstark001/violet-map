import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

export type YamlValue = string | number | boolean | null | YamlValue[] | YamlObject;
export interface YamlObject {
  [key: string]: YamlValue;
}

/** Parse a single YAML mapping, preserving nested maps and sequences. */
export function parseConfigYaml(text: string): YamlObject {
  const value: unknown = parse(text);
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('configuration root must be a YAML mapping');
  }
  return value as YamlObject;
}

/** Find the configured YAML file; malformed files fail startup with their path. */
export function findYamlConfig(): { file: string; data: YamlObject } | null {
  const explicit = process.env.VIOLET_MAP_CONFIG;
  const candidates = explicit
    ? [path.resolve(explicit)]
    : [path.resolve('violet-map.yaml'), path.resolve('violet-map.yml')];
  for (const file of candidates) {
    try {
      if (!fs.statSync(file).isFile()) throw new Error('not a file');
      return { file, data: parseConfigYaml(fs.readFileSync(file, 'utf8')) };
    } catch (error) {
      if (!explicit && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to load YAML config ${file}: ${message}`, { cause: error });
    }
  }
  return null;
}
