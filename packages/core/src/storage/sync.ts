import { cleanStoragePath } from './paths.js';
import type { WorldStorage } from './types.js';

const IDENTITY_PATH = '.violet-map/identity.json';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface WorldIdentity { schema: 1; id: string; createdAt: string; }
export type WorldIdentityStatus = 'empty-target' | 'same' | 'mismatch' | 'unverified';
export interface WorldIdentityCheck { status: WorldIdentityStatus; source?: WorldIdentity; target?: WorldIdentity; message: string; }
export interface SyncOptions { dryRun?: boolean; deleteExtra?: boolean; onProgress?: (event: { type: 'copy' | 'skip' | 'delete'; path: string }) => void; }
export interface SyncResult { copied: string[]; skipped: string[]; deleted: string[]; }

function generatedIdentity(): WorldIdentity {
  const id = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return { schema: 1, id, createdAt: new Date().toISOString() };
}
async function identity(storage: WorldStorage): Promise<WorldIdentity | undefined> {
  const bytes = await storage.read(IDENTITY_PATH);
  if (!bytes) return undefined;
  try {
    const value = JSON.parse(decoder.decode(bytes)) as Partial<WorldIdentity>;
    return value.schema === 1 && typeof value.id === 'string' && value.id.length > 0 && typeof value.createdAt === 'string' ? value as WorldIdentity : undefined;
  } catch { return undefined; }
}

/** Ensure a source archive owns a stable identity marker. */
export async function ensureWorldIdentity(storage: WorldStorage, dryRun = false): Promise<WorldIdentity> {
  const existing = await identity(storage);
  if (existing) return existing;
  const created = generatedIdentity();
  if (!dryRun) await storage.write(IDENTITY_PATH, encoder.encode(`${JSON.stringify(created, null, 2)}\n`), 'application/json');
  return created;
}

export async function checkWorldIdentity(source: WorldStorage, target: WorldStorage): Promise<WorldIdentityCheck> {
  const [sourceIdentity, targetIdentity, targetFiles] = await Promise.all([identity(source), identity(target), target.list()]);
  if (targetFiles.length === 0) return { status: 'empty-target', source: sourceIdentity, message: 'target has no files' };
  if (!sourceIdentity || !targetIdentity) return { status: 'unverified', source: sourceIdentity, target: targetIdentity, message: 'one or both worlds have no .violet-map/identity.json marker' };
  if (sourceIdentity.id !== targetIdentity.id) return { status: 'mismatch', source: sourceIdentity, target: targetIdentity, message: 'world identity markers differ' };
  return { status: 'same', source: sourceIdentity, target: targetIdentity, message: 'world identity markers match' };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('');
}
async function sameContent(source: WorldStorage, target: WorldStorage, path: string, sourceSize: number): Promise<boolean> {
  const targetInfo = await target.stat(path);
  if (!targetInfo || targetInfo.size !== sourceSize) return false;
  const [from, to] = await Promise.all([source.read(path), target.read(path)]);
  return !!from && !!to && await sha256(from) === await sha256(to);
}

/** Copy changed files from source to target. Call checkWorldIdentity first to enforce policy. */
export async function syncWorld(source: WorldStorage, target: WorldStorage, options: SyncOptions = {}): Promise<SyncResult> {
  const identityBytes = await source.read(IDENTITY_PATH);
  const sourceFiles = (await source.list()).filter((file) => cleanStoragePath(file.path) !== IDENTITY_PATH);
  const result: SyncResult = { copied: [], skipped: [], deleted: [] };
  for (const file of sourceFiles) {
    const path = cleanStoragePath(file.path);
    if (await sameContent(source, target, path, file.size)) { result.skipped.push(path); options.onProgress?.({ type: 'skip', path }); continue; }
    if (!options.dryRun) {
      const bytes = await source.read(path);
      if (!bytes) throw new Error(`source file disappeared during sync: ${path}`);
      await target.write(path, bytes);
    }
    result.copied.push(path); options.onProgress?.({ type: 'copy', path });
  }
  if (options.deleteExtra) {
    const expected = new Set(sourceFiles.map((file) => cleanStoragePath(file.path)));
    for (const file of await target.list()) {
      const path = cleanStoragePath(file.path);
      if (path === IDENTITY_PATH || expected.has(path)) continue;
      if (!options.dryRun) await target.delete(path);
      result.deleted.push(path); options.onProgress?.({ type: 'delete', path });
    }
  }
  if (identityBytes) {
    if (!options.dryRun) await target.write(IDENTITY_PATH, identityBytes, 'application/json');
    result.copied.push(IDENTITY_PATH);
    options.onProgress?.({ type: 'copy', path: IDENTITY_PATH });
  }
  return result;
}
