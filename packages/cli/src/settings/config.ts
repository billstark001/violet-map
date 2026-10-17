import { normalizeApiBaseUrl } from '@violet-map/core/contracts';
import path from 'node:path';
import { readJson, updateJson } from './files.js';
import type { CliPaths } from './paths.js';

export type CredentialBackend = 'keychain' | 'file';

export interface Profile {
  server?: { url: string };
  database?: { dir?: string; urlRef?: string };
  s3?: {
    endpoint?: string;
    bucket?: string;
    prefix?: string;
    region?: string;
    awsProfile?: string;
    credentialsRef?: string;
    forcePathStyle?: boolean;
  };
}

export interface CliConfig {
  version: 1;
  defaultProfile?: string;
  credentialStore?: CredentialBackend;
  profiles: Record<string, Profile>;
}

export const emptyConfig = (): CliConfig => ({ version: 1, profiles: {} });

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: string[], label: string) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error(`Unknown field in ${label}; credentials must be stored using references`);
}

export function validName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name))
    throw new Error('Names must be 1-64 letters, numbers, dot, dash, or underscore');
  return name;
}

export function serverBaseUrl(input: string): string {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Invalid server URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Server URL must be an HTTP(S) origin without credentials, query, or fragment');
  return normalizeApiBaseUrl(input, url.origin).replace(/\/$/, '');
}

export function validateReference(ref: string): string {
  if (!/^(env:[A-Za-z_][A-Za-z0-9_]*|secret:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}|file:.+)$/.test(ref))
    throw new Error('Credential reference must be env:NAME, secret:NAME, or file:PATH');
  return ref;
}

export function validateConfig(value: unknown): CliConfig {
  if (!object(value) || value.version !== 1 || !object(value.profiles))
    throw new Error('Expected CLI configuration version 1 and a profiles object');
  keys(value, ['version', 'defaultProfile', 'credentialStore', 'profiles'], 'CLI configuration');
  if (value.credentialStore !== undefined && !['keychain', 'file'].includes(value.credentialStore as string))
    throw new Error('credentialStore must be keychain or file');
  if (
    value.defaultProfile !== undefined &&
    (typeof value.defaultProfile !== 'string' || !Object.hasOwn(value.profiles, value.defaultProfile))
  )
    throw new Error('defaultProfile must name an existing profile');
  for (const [name, profile] of Object.entries(value.profiles)) {
    validName(name);
    if (!object(profile)) throw new Error(`Invalid profile ${name}`);
    keys(profile, ['server', 'database', 's3'], `profile ${name}`);
    for (const [section, fields] of Object.entries(profile)) {
      const allowed =
        section === 'server'
          ? ['url']
          : section === 'database'
            ? ['dir', 'urlRef']
            : ['endpoint', 'bucket', 'prefix', 'region', 'awsProfile', 'credentialsRef', 'forcePathStyle'];
      if (!object(fields)) throw new Error(`Invalid ${section} configuration`);
      keys(fields, allowed, section);
      for (const [key, field] of Object.entries(fields)) {
        if (
          key === 'forcePathStyle'
            ? typeof field !== 'boolean'
            : typeof field !== 'string' || (!field && key !== 'prefix')
        )
          throw new Error(`Invalid ${section}.${key}`);
        if (key.endsWith('Ref')) validateReference(field as string);
      }
      if (section === 'server') {
        if (typeof fields.url !== 'string') throw new Error('server.url is required');
        serverBaseUrl(fields.url);
      }
      if (section === 's3' && fields.endpoint) {
        const endpoint = new URL(fields.endpoint as string);
        if (
          !['https:', 'http:'].includes(endpoint.protocol) ||
          endpoint.username ||
          endpoint.password ||
          endpoint.search ||
          endpoint.hash
        )
          throw new Error('S3 endpoint must not contain credentials, query, or fragment');
      }
    }
  }
  return value as unknown as CliConfig;
}

export async function loadConfig(paths: CliPaths, explicit = false): Promise<CliConfig> {
  return validateConfig(
    await readJson(paths.configFile, () => {
      if (explicit) throw new Error(`CLI configuration not found: ${paths.configFile}`);
      return emptyConfig();
    }),
  );
}

export async function editConfig(paths: CliPaths, edit: (value: CliConfig) => void) {
  return updateJson(paths.configFile, emptyConfig, (value) => {
    validateConfig(value);
    edit(value);
    validateConfig(value);
  });
}

export function selectProfile(config: CliConfig, name?: string): { name?: string; profile: Profile } {
  const selected = name ?? config.defaultProfile;
  if (selected && !Object.hasOwn(config.profiles, selected)) throw new Error(`Unknown profile: ${selected}`);
  return { name: selected, profile: selected ? config.profiles[selected] : {} };
}

export const profilePath = (paths: CliPaths, value: string) => path.resolve(path.dirname(paths.configFile), value);
