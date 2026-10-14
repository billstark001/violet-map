import path from 'node:path';
import type { CliContext } from '../context.js';
import {
  editConfig,
  validName,
  serverBaseUrl,
  profilePath,
  validateReference,
  type Profile,
} from '../settings/config.js';
import { editState, loadState } from '../settings/state.js';
import { readSecret } from '../input.js';

export interface ProfileOptions {
  serverUrl?: string;
  databaseDir?: string;
  databaseUrlRef?: string;
  s3Endpoint?: string;
  s3Bucket?: string;
  s3Region?: string;
  s3Prefix?: string;
  awsProfile?: string;
  s3CredentialsRef?: string;
  s3VirtualHosted?: boolean;
}
export async function setProfile(context: CliContext, name: string, options: ProfileOptions) {
  validName(name);
  await editConfig(context.paths, (config) => {
    const profile: Profile = config.profiles[name] ?? {};
    if (options.serverUrl !== undefined) profile.server = { url: serverBaseUrl(options.serverUrl) };
    if (options.databaseDir !== undefined || options.databaseUrlRef !== undefined)
      profile.database = {
        ...profile.database,
        ...(options.databaseDir === undefined ? {} : { dir: options.databaseDir }),
        ...(options.databaseUrlRef === undefined ? {} : { urlRef: validateReference(options.databaseUrlRef) }),
      };
    const pairs = [
      ['s3Endpoint', 'endpoint'],
      ['s3Bucket', 'bucket'],
      ['s3Region', 'region'],
      ['s3Prefix', 'prefix'],
      ['awsProfile', 'awsProfile'],
      ['s3CredentialsRef', 'credentialsRef'],
    ] as const;
    for (const [flag, key] of pairs)
      if (options[flag] !== undefined) profile.s3 = { ...profile.s3, [key]: options[flag] };
    if (options.s3VirtualHosted !== undefined) profile.s3 = { ...profile.s3, forcePathStyle: !options.s3VirtualHosted };
    config.profiles[name] = profile;
  });
  console.log(`Saved profile ${name}.`);
}
export async function useProfile(context: CliContext, name: string) {
  await editConfig(context.paths, (config) => {
    if (!Object.hasOwn(config.profiles, name)) throw new Error(`Unknown profile: ${name}`);
    config.defaultProfile = name;
  });
  console.log(`Default profile: ${name}`);
}
export async function deleteProfile(context: CliContext, name: string) {
  if (!Object.hasOwn(context.config.profiles, name)) throw new Error(`Unknown profile: ${name}`);
  for (const [key, session] of Object.entries((await loadState(context.paths)).sessions)) {
    if (session.profile !== name) continue;
    await context.secrets.delete(session.secret);
    await editState(context.paths, (state) => {
      delete state.sessions[key];
    });
  }
  await editConfig(context.paths, (config) => {
    delete config.profiles[name];
    if (config.defaultProfile === name) delete config.defaultProfile;
  });
  console.log(`Deleted profile ${name}; remote credentials expire or can be revoked separately.`);
}
export function showConfig(context: CliContext, sources: boolean) {
  const server = context.options.serverUrl ?? context.env.VIOLET_SERVER_URL ?? context.profile.server?.url;
  const databaseDir = context.env.DATABASE_DIR
    ? path.resolve(context.env.DATABASE_DIR)
    : context.profile.database?.dir
      ? profilePath(context.paths, context.profile.database.dir)
      : undefined;
  const value: Record<string, unknown> = {
    profile: context.profileName,
    settings: {
      server: server ? { url: serverBaseUrl(server) } : undefined,
      database: {
        dir: databaseDir,
        urlRef: context.env.DATABASE_URL ? 'env:DATABASE_URL' : context.profile.database?.urlRef,
      },
      s3: {
        ...context.profile.s3,
        endpoint: context.env.S3_ENDPOINT ?? context.profile.s3?.endpoint,
        bucket: context.env.S3_BUCKET ?? context.profile.s3?.bucket,
        prefix: context.env.S3_PREFIX ?? context.profile.s3?.prefix,
        region: context.env.S3_REGION ?? context.profile.s3?.region,
      },
    },
    credentialStore: context.secrets.backend,
  };
  if (sources)
    value.sources = {
      configFile: context.options.config
        ? 'argument'
        : context.env.VIOLET_MAP_CLI_CONFIG
          ? 'VIOLET_MAP_CLI_CONFIG'
          : 'platform/CLI home',
      profile: context.options.profile
        ? 'argument'
        : context.env.VIOLET_MAP_PROFILE
          ? 'VIOLET_MAP_PROFILE'
          : 'defaultProfile',
      serverUrl: context.options.serverUrl
        ? 'argument'
        : context.env.VIOLET_SERVER_URL
          ? 'VIOLET_SERVER_URL'
          : 'profile',
      serverCredential: context.options.serverTokenRef
        ? 'argument reference'
        : context.env.VIOLET_SERVER_TOKEN !== undefined
          ? 'VIOLET_SERVER_TOKEN'
          : 'saved login',
      databaseCredential: context.env.DATABASE_URL !== undefined ? 'DATABASE_URL' : 'profile reference',
    };
  // Never dereference credentials while inspecting configuration.
  console.log(JSON.stringify(value, null, 2));
}
export async function setCredential(context: CliContext, name: string, options: { stdin?: boolean; file?: string }) {
  validName(name);
  if (!options.stdin && !options.file) throw new Error('Use --stdin or --file to provide a credential');
  await context.secrets.set(name, await readSecret(options, 'Credential'));
  console.log(`Saved credential reference secret:${name}.`);
}
