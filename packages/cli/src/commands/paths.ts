import path from 'node:path';
import { isDimensionId } from '@violet-map/core/domain';

export function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export function resolvePath(input: string): string {
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), input);
}

export function parseDim(value = 'minecraft:overworld'): string {
  const id = value.includes(':') ? value : `minecraft:${value}`;
  if (!isDimensionId(id)) throw new Error(`invalid dimension id: ${value}`);
  return id;
}

export function splitAssetDirs(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolvePath(p));
}

export function resolveAssetDirs(value?: string): string[] {
  const explicit = splitAssetDirs(value);
  if (explicit.length) return explicit;
  const env = splitAssetDirs(process.env.ASSETS_DIRS);
  if (env.length) return env;
  return [resolvePath('assets')];
}
