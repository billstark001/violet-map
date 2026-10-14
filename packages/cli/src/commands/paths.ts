import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

export function encodeBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

export function encodeTypedArray(values: Uint16Array | Uint32Array | Uint8Array | Int16Array): string {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString('base64');
}

export function sha1Bytes(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex');
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

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function pathExists(file: string): Promise<boolean> {
  if (existsSync(file)) return true;
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    throw error;
  }
}
