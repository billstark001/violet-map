import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readJson, updateJson } from './files.js';
import { loadState, editState, type SecretRecord } from './state.js';
import { validateReference, type CredentialBackend } from './config.js';
import type { CliPaths } from './paths.js';

const sensitive = new Set<string>();
export function sensitiveValue(value: string): string {
  if (value) sensitive.add(value);
  return value;
}
export function redact(message: string): string {
  for (const secret of [...sensitive].sort((a, b) => b.length - a.length))
    message = message.split(secret).join('[REDACTED]');
  return message
    .replace(/\b(?:postgres(?:ql)?|s3):\/\/[^\s"']+/gi, '[REDACTED CONNECTION]')
    .replace(/\bvm_[A-Za-z0-9_-]+/g, '[REDACTED TOKEN]');
}

export class SecretStore {
  constructor(
    readonly paths: CliPaths,
    readonly backend: CredentialBackend,
    readonly env: NodeJS.ProcessEnv = process.env,
  ) {}
  private async entry(id: string) {
    try {
      const { AsyncEntry } = await import('@napi-rs/keyring');
      return new AsyncEntry(`violet-map.cli.${this.paths.namespace}`, id, { linux: { store: 'secret-service' } });
    } catch {
      throw new Error(
        'System credential store is unavailable; provide an environment/file reference or explicitly select --credential-store file',
      );
    }
  }
  private async fileValues(): Promise<Record<string, string>> {
    const stat = await fs.lstat(this.paths.credentialFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (stat && (stat.isSymbolicLink() || (process.platform !== 'win32' && stat.mode & 0o077)))
      throw new Error('Credential file must be a regular private file with mode 0600');
    const value = await readJson<Record<string, string>>(this.paths.credentialFile, () => ({}));
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.values(value).some((secret) => typeof secret !== 'string')
    )
      throw new Error('Invalid CLI credential file');
    return value;
  }
  private async read(record: SecretRecord): Promise<string> {
    const value =
      record.backend === 'file'
        ? (await this.fileValues())[record.id]
        : await (await this.entry(record.id)).getPassword();
    if (!value) throw new Error('Stored credential is missing; sign in again or replace the credential');
    return sensitiveValue(value);
  }
  private async remove(record: SecretRecord) {
    if (record.backend === 'file') {
      await this.fileValues();
      await updateJson<Record<string, string>>(
        this.paths.credentialFile,
        () => ({}),
        (value) => {
          delete value[record.id];
        },
      );
    } else await (await this.entry(record.id)).deleteCredential();
  }
  async set(name: string, value: string): Promise<void> {
    sensitiveValue(value);
    const previous = (await loadState(this.paths)).secrets[name];
    const record = { backend: this.backend, id: randomUUID() };
    if (this.backend === 'file') {
      await this.fileValues();
      await updateJson<Record<string, string>>(
        this.paths.credentialFile,
        () => ({}),
        (values) => {
          values[record.id] = value;
        },
      );
    } else {
      try {
        await (await this.entry(record.id)).setPassword(value);
      } catch {
        throw new Error(
          'Cannot save to the system credential store; explicitly select --credential-store file or use injected credentials',
        );
      }
    }
    try {
      await editState(this.paths, (state) => {
        state.secrets[name] = record;
      });
    } catch (error) {
      await this.remove(record);
      throw error;
    }
    if (previous) {
      try {
        await this.remove(previous);
      } catch {
        // The replacement is already committed. Keep a cleanup reference instead of
        // reporting that the new secret was not saved or losing track of the old one.
        const retired = `retired-${previous.id}`;
        await editState(this.paths, (state) => {
          state.secrets[retired] = previous;
        });
        console.error(
          `Credential saved; the old credential could not be removed. Retry credentials delete ${retired} when its backend is available.`,
        );
      }
    }
  }
  async delete(name: string): Promise<void> {
    const record = (await loadState(this.paths)).secrets[name];
    if (record) await this.remove(record);
    await editState(this.paths, (state) => {
      delete state.secrets[name];
    });
  }
  async get(name: string): Promise<string> {
    const record = (await loadState(this.paths)).secrets[name];
    if (!record) throw new Error(`Credential not found: ${name}`);
    return this.read(record);
  }
  async resolve(reference: string, base = path.dirname(this.paths.configFile)): Promise<string> {
    validateReference(reference);
    const separator = reference.indexOf(':');
    const type = reference.slice(0, separator),
      key = reference.slice(separator + 1);
    const value =
      type === 'secret'
        ? await this.get(key)
        : type === 'env'
          ? this.env[key]
          : await fs.readFile(path.resolve(base, key), 'utf8');
    if (!value?.trim()) throw new Error(`Credential reference is empty or unavailable: ${type === 'env' ? key : type}`);
    return sensitiveValue(value.trimEnd());
  }
}

export const sessionKey = (profile: string, url: string) =>
  createHash('sha256')
    .update(JSON.stringify([profile, url]))
    .digest('hex');
