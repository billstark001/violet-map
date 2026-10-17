import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadContext } from '../src/context.js';
import { editConfig } from '../src/settings/config.js';
import { cliPaths } from '../src/settings/paths.js';
import { redact } from '../src/settings/secrets.js';
import { targetStorage, runWorldSync, type WorldSyncOptions } from '../src/commands/world.js';

const base: WorldSyncOptions = { from: '/unused', world: 'survival', target: 's3' };

test('S3 provider selection is explicit, atomic, and supports temporary credentials', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-s3-options-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await editConfig(cliPaths({ cliHome: home }), (config) => {
    config.defaultProfile = 'archive';
    config.profiles.archive = { s3: { bucket: 'archive', awsProfile: 'maps' } };
  });
  const env = {
    INJECTED_S3: JSON.stringify({
      accessKeyId: 'test-access-id',
      secretAccessKey: 'test-secret-key',
      sessionToken: 'test-session-token',
    }),
  };
  const referenced = await targetStorage(
    { ...base, s3CredentialsRef: 'env:INJECTED_S3' },
    await loadContext({ cliHome: home }, env),
  );
  assert.equal(referenced.kind, 's3');
  if (referenced.kind !== 's3') throw new Error('Expected S3');
  assert.equal(typeof referenced.credentials, 'object');
  assert.equal((referenced.credentials as { sessionToken: string }).sessionToken, 'test-session-token');
  assert.equal(redact('test-secret-key test-session-token'), '[REDACTED] [REDACTED]');
  await assert.rejects(
    targetStorage(base, await loadContext({ cliHome: home }, { S3_ACCESS_KEY_ID: 'partial' })),
    /supplied together/,
  );
  const temporary = await targetStorage(
    base,
    await loadContext(
      { cliHome: home },
      { S3_ACCESS_KEY_ID: 'env-id', S3_SECRET_ACCESS_KEY: 'env-secret', S3_SESSION_TOKEN: 'env-session' },
    ),
  );
  assert.equal(temporary.kind, 's3');
  if (temporary.kind !== 's3') throw new Error('Expected S3');
  assert.equal((temporary.credentials as { sessionToken: string }).sessionToken, 'env-session');
  const blank = await targetStorage(
    base,
    await loadContext(
      { cliHome: home },
      { S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '', S3_SESSION_TOKEN: '', S3_ENDPOINT: '', S3_REGION: '' },
    ),
  );
  assert.equal(blank.kind === 's3' && typeof blank.credentials, 'function');
  assert.equal(blank.kind === 's3' && blank.endpoint, undefined);
  const sdk = await targetStorage(
    { ...base, awsProfile: 'explicit' },
    await loadContext({ cliHome: home }, { S3_ACCESS_KEY_ID: 'partial' }),
  );
  assert.equal(sdk.kind === 's3' && typeof sdk.credentials, 'function');
});

test('remote authorization fails before creating source identity or trying another target', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-sync-auth-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const context = await loadContext({ cliHome: path.join(root, 'cli'), serverUrl: 'https://example.test' }, {});
  await assert.rejects(runWorldSync({ ...base, from: root, target: 'server' }, context), /No login/);
  await assert.rejects(fs.stat(path.join(root, '.violet-map/identity.json')), { code: 'ENOENT' });
});
