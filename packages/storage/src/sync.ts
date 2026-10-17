import { copyObjects } from './copy.js';
import type { ObjectStorage } from '@violet-map/core/storage';

const IDENTITY_PATH = '.violet-map/identity.json';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface WorldIdentity {
  schema: 1;
  id: string;
  createdAt: string;
}
export type WorldIdentityStatus = 'empty-target' | 'same' | 'mismatch' | 'unverified';
export interface WorldIdentityCheck {
  status: WorldIdentityStatus;
  source?: WorldIdentity;
  target?: WorldIdentity;
  message: string;
}
export interface SyncOptions {
  dryRun?: boolean;
  deleteExtra?: boolean;
  onProgress?: (event: { type: 'copy' | 'skip' | 'delete'; path: string }) => void;
}
export interface SyncResult {
  copied: string[];
  skipped: string[];
  deleted: string[];
}

function generatedIdentity(): WorldIdentity {
  const id =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return { schema: 1, id, createdAt: new Date().toISOString() };
}
async function identity(storage: ObjectStorage): Promise<WorldIdentity | undefined> {
  const bytes = await storage.read(IDENTITY_PATH);
  if (!bytes) return undefined;
  try {
    const value = JSON.parse(decoder.decode(bytes)) as Partial<WorldIdentity>;
    return value.schema === 1 &&
      typeof value.id === 'string' &&
      value.id.length > 0 &&
      typeof value.createdAt === 'string'
      ? (value as WorldIdentity)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Ensure a source archive owns a stable identity marker. */
export async function ensureWorldIdentity(storage: ObjectStorage, dryRun = false): Promise<WorldIdentity> {
  const existing = await identity(storage);
  if (existing) return existing;
  const created = generatedIdentity();
  if (!dryRun)
    await storage.write(IDENTITY_PATH, encoder.encode(`${JSON.stringify(created, null, 2)}\n`), 'application/json');
  return created;
}

export async function checkWorldIdentity(source: ObjectStorage, target: ObjectStorage): Promise<WorldIdentityCheck> {
  const [sourceIdentity, targetIdentity, targetFiles] = await Promise.all([
    identity(source),
    identity(target),
    target.list(),
  ]);
  if (targetFiles.length === 0)
    return { status: 'empty-target', source: sourceIdentity, message: 'target has no files' };
  if (!sourceIdentity || !targetIdentity)
    return {
      status: 'unverified',
      source: sourceIdentity,
      target: targetIdentity,
      message: 'one or both worlds have no .violet-map/identity.json marker',
    };
  if (sourceIdentity.id !== targetIdentity.id)
    return {
      status: 'mismatch',
      source: sourceIdentity,
      target: targetIdentity,
      message: 'world identity markers differ',
    };
  return { status: 'same', source: sourceIdentity, target: targetIdentity, message: 'world identity markers match' };
}

/** Copy changed files from source to target. Call checkWorldIdentity first to enforce policy. */
export async function syncWorld(
  source: ObjectStorage,
  target: ObjectStorage,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const identityBytes = await source.read(IDENTITY_PATH);
  const result = await copyObjects(source, target, { ...options, exclude: [IDENTITY_PATH] });
  if (identityBytes) {
    if (!options.dryRun) await target.write(IDENTITY_PATH, identityBytes, 'application/json');
    result.copied.push(IDENTITY_PATH);
    options.onProgress?.({ type: 'copy', path: IDENTITY_PATH });
  }
  return result;
}
