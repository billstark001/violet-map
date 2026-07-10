import {
  checkWorldIdentity,
  createWorldStorage,
  ensureWorldIdentity,
  LocalWorldStorage,
  PrefixedWorldStorage,
  syncWorld,
  type StorageOptions,
} from '@violet-map/core/storage';
import { argsReader, required, resolvePath } from './common.js';

function usage(): string {
  return `Usage:
  vm-assets world sync --from <local-world-dir> --world <world-name> --target <local|s3|server> [options]

Targets:
  local:  --target-dir <worlds-root>
  s3:     --s3-bucket <bucket> [--s3-endpoint <url>] [--s3-region <region>] [--s3-prefix <prefix>]
          [--s3-access-key <key>] [--s3-secret-key <secret>] [--s3-virtual-hosted]
  server: --server-url <url> --server-token <credential>

Safety: the source is given a stable .violet-map/identity.json marker. An existing
target with a different or missing marker requires --force. Use --dry-run to inspect
changes and --delete to also remove target files absent from the source.`;
}

function targetStorage(args: string[]): StorageOptions {
  const reader = argsReader(args);
  const target = reader.get('--target', 'local')?.toLowerCase();
  switch (target) {
    case 'local':
      return { kind: 'local', root: resolvePath(required(reader.get('--target-dir'), '--target-dir')) };
    case 's3': {
      const bucket = reader.get('--s3-bucket') ?? process.env.S3_BUCKET;
      if (!bucket) throw new Error('missing --s3-bucket');
      return {
        kind: 's3', bucket,
        endpoint: reader.get('--s3-endpoint') ?? process.env.S3_ENDPOINT,
        region: reader.get('--s3-region') ?? process.env.S3_REGION ?? 'auto',
        prefix: reader.get('--s3-prefix') ?? process.env.S3_PREFIX,
        accessKeyId: reader.get('--s3-access-key') ?? process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: reader.get('--s3-secret-key') ?? process.env.S3_SECRET_ACCESS_KEY,
        forcePathStyle: !reader.flag('--s3-virtual-hosted'),
      };
    }
    case 'server': {
      const url = reader.get('--server-url') ?? process.env.VIOLET_SERVER_URL;
      const token = reader.get('--server-token') ?? process.env.VIOLET_SERVER_TOKEN;
      if (!url || !token) throw new Error('server target needs --server-url and --server-token');
      return { kind: 'server', url, token };
    }
    default:
      throw new Error(`unknown --target ${target}; expected local, s3, or server`);
  }
}

export async function runWorldCommand(args: string[]): Promise<void> {
  const command = args[0];
  if (!command || command === 'help' || command === '--help' || command === '-h') return void console.log(usage());
  if (command !== 'sync') throw new Error(`unknown world command: ${command}\n${usage()}`);
  const reader = argsReader(args);
  const from = resolvePath(required(reader.get('--from'), '--from'));
  const world = required(reader.get('--world'), '--world');
  if (!/^[A-Za-z0-9_.-]+$/.test(world)) throw new Error('--world may only contain letters, numbers, dot, dash, and underscore');
  const dryRun = reader.flag('--dry-run');
  const source = new LocalWorldStorage(from);
  const target = new PrefixedWorldStorage(createWorldStorage(targetStorage(args)), world);
  const sourceIdentity = await ensureWorldIdentity(source, dryRun);
  const check = await checkWorldIdentity(source, target);
  console.log(`World identity: ${check.status} (${check.message})`);
  if (check.status === 'mismatch' || check.status === 'unverified') {
    console.warn(`WARNING: source ${sourceIdentity.id}; target ${check.target?.id ?? 'has no identity marker'}.`);
    if (!reader.flag('--force')) throw new Error('refusing to sync a world whose identity cannot be proven. Re-run with --force only after verifying the target.');
  }
  const result = await syncWorld(source, target, {
    dryRun,
    deleteExtra: reader.flag('--delete'),
    onProgress: ({ type, path }) => console.log(`${type.padEnd(6)} ${path}`),
  });
  console.log(`${dryRun ? 'Dry run: ' : ''}${result.copied.length} copied, ${result.skipped.length} unchanged, ${result.deleted.length} deleted.`);
}
