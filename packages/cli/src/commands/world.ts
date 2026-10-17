import { loadCapability } from '../capabilities.js';

import type { StorageOptions, S3StorageOptions } from '@violet-map/storage/types';

import path from 'node:path';
import type { CliContext } from '../context.js';
import { resolveServerConnection } from '../remote.js';
import { sensitiveValue } from '../settings/secrets.js';

export interface WorldSyncOptions {
  from: string;
  world: string;
  target: 'local' | 's3' | 'server';
  targetDir?: string;
  s3Bucket?: string;
  s3Endpoint?: string;
  s3Region?: string;
  s3Prefix?: string;
  awsProfile?: string;
  s3CredentialsRef?: string;
  s3VirtualHosted?: boolean;
  dryRun?: boolean;
  delete?: boolean;
  force?: boolean;
}
export async function targetStorage(options: WorldSyncOptions, context: CliContext): Promise<StorageOptions> {
  if (options.target === 'local') {
    if (!options.targetDir) throw new Error('Local target requires --target-dir');
    return { kind: 'local', root: path.resolve(options.targetDir) };
  }
  if (options.target === 'server') return { kind: 'server', ...(await resolveServerConnection(context)) };
  const profile = context.profile.s3;
  const bucket = options.s3Bucket ?? context.env.S3_BUCKET ?? profile?.bucket;
  if (!bucket) throw new Error('S3 target requires a bucket');
  const explicitProvider = options.s3CredentialsRef !== undefined || options.awsProfile !== undefined;
  const environmentProvider =
    !!context.env.S3_ACCESS_KEY_ID || !!context.env.S3_SECRET_ACCESS_KEY || !!context.env.S3_SESSION_TOKEN;
  const sdkEnvironment =
    context.env.AWS_PROFILE ||
    context.env.AWS_ACCESS_KEY_ID ||
    context.env.AWS_SECRET_ACCESS_KEY ||
    context.env.AWS_WEB_IDENTITY_TOKEN_FILE ||
    context.env.AWS_ROLE_ARN;
  const ref =
    options.s3CredentialsRef ??
    (!explicitProvider && !environmentProvider && !sdkEnvironment ? profile?.credentialsRef : undefined);
  const awsProfile =
    options.awsProfile ??
    (!explicitProvider && !environmentProvider && !sdkEnvironment ? profile?.awsProfile : undefined);
  if (ref && awsProfile) throw new Error('Choose an AWS profile or an S3 credential reference');
  let credentials: S3StorageOptions['credentials'];
  if (ref) {
    const raw = await context.secrets.resolve(
      ref,
      options.s3CredentialsRef ? process.cwd() : path.dirname(context.paths.configFile),
    );
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error('S3 credential reference must contain JSON credentials');
    }
    if (
      !value ||
      typeof value.accessKeyId !== 'string' ||
      !value.accessKeyId ||
      typeof value.secretAccessKey !== 'string' ||
      !value.secretAccessKey ||
      (value.sessionToken !== undefined && typeof value.sessionToken !== 'string')
    )
      throw new Error('S3 credentials require accessKeyId and secretAccessKey, with an optional sessionToken');
    credentials = {
      accessKeyId: sensitiveValue(value.accessKeyId),
      secretAccessKey: sensitiveValue(value.secretAccessKey),
      sessionToken: value.sessionToken === undefined ? undefined : sensitiveValue(value.sessionToken),
    };
  } else if (awsProfile) {
    const { profileCredentials } = await loadCapability('@violet-map/storage/s3');
    credentials = () => profileCredentials({ profile: awsProfile });
  } else if (!!context.env.S3_ACCESS_KEY_ID || !!context.env.S3_SECRET_ACCESS_KEY || !!context.env.S3_SESSION_TOKEN) {
    if (!context.env.S3_ACCESS_KEY_ID || !context.env.S3_SECRET_ACCESS_KEY)
      throw new Error('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be supplied together');
    credentials = {
      accessKeyId: sensitiveValue(context.env.S3_ACCESS_KEY_ID),
      secretAccessKey: sensitiveValue(context.env.S3_SECRET_ACCESS_KEY),
      sessionToken: context.env.S3_SESSION_TOKEN ? sensitiveValue(context.env.S3_SESSION_TOKEN) : undefined,
    };
  }
  const endpoint = options.s3Endpoint ?? (context.env.S3_ENDPOINT || undefined) ?? profile?.endpoint;
  if (endpoint === '') throw new Error('S3 endpoint must not be empty');
  if (endpoint) {
    const parsed = new URL(endpoint);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error('S3 endpoint must not contain credentials, query, or fragment');
  }
  return {
    kind: 's3',
    bucket,
    endpoint,
    region: options.s3Region ?? (context.env.S3_REGION || undefined) ?? profile?.region ?? 'auto',
    prefix: options.s3Prefix ?? context.env.S3_PREFIX ?? profile?.prefix,
    forcePathStyle:
      options.s3VirtualHosted !== undefined ? !options.s3VirtualHosted : (profile?.forcePathStyle ?? true),
    credentials,
  };
}
export async function runWorldSync(options: WorldSyncOptions, context: CliContext): Promise<void> {
  if (!options.from) throw new Error('--from must not be empty');
  if (!/^[A-Za-z0-9_.-]+$/.test(options.world))
    throw new Error('--world may only contain letters, numbers, dot, dash, and underscore');
  const storageOptions = await targetStorage(options, context);
  const { checkWorldIdentity, ensureWorldIdentity, ScopedStorage, syncWorld } =
    await loadCapability('@violet-map/storage');
  const { LocalStorage } = await loadCapability('@violet-map/storage/local');
  const source = new LocalStorage(path.resolve(options.from));
  const target = new ScopedStorage(
    storageOptions.kind === 'server'
      ? new (await loadCapability('@violet-map/storage/server')).ServerWorldStorage(storageOptions)
      : await (await loadCapability('@violet-map/storage/factory')).createObjectStorage(storageOptions),
    options.world,
  );
  const sourceIdentity = await ensureWorldIdentity(source, !!options.dryRun);
  const check = await checkWorldIdentity(source, target);
  console.log(`World identity: ${check.status} (${check.message})`);
  if (check.status === 'mismatch' || check.status === 'unverified') {
    console.warn(`WARNING: source ${sourceIdentity.id}; target ${check.target?.id ?? 'has no identity marker'}.`);
    if (!options.force)
      throw new Error(
        'refusing to sync a world whose identity cannot be proven. Re-run with --force only after verifying the target.',
      );
  }
  const result = await syncWorld(source, target, {
    dryRun: !!options.dryRun,
    deleteExtra: !!options.delete,
    onProgress: ({ type, path }) => console.log(`${type.padEnd(6)} ${path}`),
  });
  console.log(
    `${options.dryRun ? 'Dry run: ' : ''}${result.copied.length} copied, ${result.skipped.length} unchanged, ${result.deleted.length} deleted.`,
  );
}
