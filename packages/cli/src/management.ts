import { loadCapability } from './capabilities.js';
import path from 'node:path';
import type { PublicUser, CreatableRole, IssuedCredential } from '@violet-map/core/contracts';
import type { CliContext } from './context.js';
import { apiRequest, jsonRequest, resolveServerConnection } from './remote.js';
import { profilePath } from './settings/config.js';
import { sensitiveValue } from './settings/secrets.js';

export interface ManagementOptions {
  via?: 'api' | 'database';
  databaseDir?: string;
  databaseUrlRef?: string;
  serverConfig?: string;
}
export interface ManagementClient {
  users: {
    list(): Promise<PublicUser[]>;
    create(input: { username: string; password: string; role: CreatableRole }): Promise<PublicUser>;
    update(
      username: string,
      input: { password?: string; role?: CreatableRole; enabled?: boolean },
    ): Promise<PublicUser>;
    delete(username: string): Promise<unknown>;
  };
  credentials: {
    issue(username: string, seconds: number): Promise<IssuedCredential>;
    revoke(username: string): Promise<unknown>;
  };
  close(): Promise<void>;
}
export async function managementClient(context: CliContext, options: ManagementOptions): Promise<ManagementClient> {
  if (options.databaseDir === '' || options.databaseUrlRef === '' || options.serverConfig === '')
    throw new Error('Database connection options must not be empty');
  if (options.databaseDir && options.databaseUrlRef)
    throw new Error('Choose a database directory or a database URL reference');
  if ((options.via ?? 'api') === 'api') {
    if (options.databaseDir || options.databaseUrlRef || options.serverConfig)
      throw new Error('Database options require --via database');
    const remote = await resolveServerConnection(context);
    const userPath = (username: string) => `api/admin/users/${encodeURIComponent(username)}`;
    return {
      users: {
        list: () => apiRequest(remote, 'api/admin/users'),
        create: (input) => apiRequest(remote, 'api/admin/users', jsonRequest('POST', input)),
        update: (username, input) => apiRequest(remote, userPath(username), jsonRequest('PATCH', input)),
        delete: (username) => apiRequest(remote, userPath(username), jsonRequest('DELETE')),
      },
      credentials: {
        issue: (username, expiresInSeconds) =>
          apiRequest(remote, `${userPath(username)}/credentials`, jsonRequest('POST', { expiresInSeconds })),
        revoke: (username) => apiRequest(remote, `${userPath(username)}/credentials`, jsonRequest('DELETE')),
      },
      close: async () => {},
    };
  }
  if (context.options.serverUrl || context.options.serverTokenRef)
    throw new Error('Server connection options cannot be used with --via database');
  const { createAdminContext, readAdminConfig } = await loadCapability('@violet-map/server/admin');
  const explicitDirectory = options.databaseDir !== undefined;
  const environmentDirectory = context.env.DATABASE_DIR || context.env.DATA_DIR;
  const ref =
    options.databaseUrlRef ??
    (explicitDirectory
      ? undefined
      : context.env.DATABASE_URL
        ? 'env:DATABASE_URL'
        : environmentDirectory || options.serverConfig
          ? undefined
          : context.profile.database?.urlRef);
  const databaseUrl = ref
    ? await context.secrets.resolve(
        ref,
        options.databaseUrlRef ? process.cwd() : path.dirname(context.paths.configFile),
      )
    : undefined;
  if (databaseUrl) sensitiveValue(databaseUrl);
  const databaseDir = options.databaseDir
    ? path.resolve(options.databaseDir)
    : context.env.DATABASE_DIR
      ? path.resolve(context.env.DATABASE_DIR)
      : !environmentDirectory && !options.serverConfig && context.profile.database?.dir
        ? profilePath(context.paths, context.profile.database.dir)
        : undefined;
  return createAdminContext(
    readAdminConfig({
      env: context.env,
      configFile: options.serverConfig,
      databaseUrl: explicitDirectory ? '' : databaseUrl,
      databaseDir,
    }),
  );
}
export async function withManagement<T>(
  context: CliContext,
  options: ManagementOptions,
  run: (client: ManagementClient) => Promise<T>,
): Promise<T> {
  let interrupted: number | undefined;
  const sigint = () => {
      interrupted = 130;
    },
    sigterm = () => {
      interrupted = 143;
    };
  if (options.via === 'database') {
    process.on('SIGINT', sigint);
    process.on('SIGTERM', sigterm);
  }
  let client: ManagementClient | undefined;
  try {
    client = await managementClient(context, options);
    if (interrupted) throw new Error('Interrupted while opening the database');
    return await run(client);
  } finally {
    try {
      await client?.close();
    } finally {
      process.off('SIGINT', sigint);
      process.off('SIGTERM', sigterm);
      if (interrupted) process.exitCode = interrupted;
    }
  }
}
