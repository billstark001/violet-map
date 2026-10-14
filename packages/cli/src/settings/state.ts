import { readJson, updateJson } from './files.js';
import type { CredentialBackend } from './config.js';
import type { CliPaths } from './paths.js';

export interface Session {
  profile: string;
  url: string;
  username: string;
  expiresAt: string;
  secret: string;
}
export interface SecretRecord {
  backend: CredentialBackend;
  id: string;
}
export interface CliState {
  version: 1;
  sessions: Record<string, Session>;
  secrets: Record<string, SecretRecord>;
}
export const emptyState = (): CliState => ({ version: 1, sessions: {}, secrets: {} });
function validate(value: CliState): CliState {
  const record = (input: unknown): input is Record<string, unknown> =>
    !!input && typeof input === 'object' && !Array.isArray(input);
  if (!record(value) || value.version !== 1 || !record(value.sessions) || !record(value.secrets))
    throw new Error('Invalid CLI state');
  for (const secret of Object.values(value.secrets)) {
    if (
      !record(secret) ||
      !['file', 'keychain'].includes(secret.backend as string) ||
      typeof secret.id !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(secret.id)
    )
      throw new Error('Invalid CLI credential metadata');
  }
  for (const session of Object.values(value.sessions)) {
    if (
      !record(session) ||
      !['profile', 'url', 'username', 'expiresAt', 'secret'].every((key) => typeof session[key] === 'string')
    )
      throw new Error('Invalid CLI session metadata');
  }
  return value;
}
export const loadState = async (paths: CliPaths) => validate(await readJson(paths.stateFile, emptyState));
export const editState = (paths: CliPaths, edit: (value: CliState) => void) =>
  updateJson(paths.stateFile, emptyState, (value) => {
    validate(value);
    edit(value);
    validate(value);
  });
