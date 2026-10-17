import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { invoke } from './helpers.js';

test('Commander help is side-effect free, rejects old/admin/maintenance commands, and scopes Minecraft versions', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-program-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { home: root, env: { VIOLET_MAP_CONFIG: '/missing/server.yaml' } };
  const { version } = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const help = (await invoke(['--help'], options)).stdout;
  assert.match(help, /Usage: violet-map/);
  assert.doesNotMatch(help, /vm-cli|vm-admin|db:migrate/);
  assert.equal((await invoke(['--version'], options)).stdout.trim(), version);
  const extraction = (await invoke(['assets', 'extract', '--help'], options)).stdout;
  assert.match(extraction, /Minecraft version/);
  for (const args of [
    ['db', 'migrate'],
    ['admin', 'users', 'list'],
    ['users', 'list', '--unknown'],
    ['users', 'update', '--username', 'alice', '--enable', '--disable'],
    ['profile-mca', '--limit', '2'],
  ])
    await assert.rejects(invoke(args, options));
  const assets = path.join(root, 'cache/assets');
  await fs.mkdir(assets, { recursive: true });
  await fs.writeFile(
    path.join(assets, 'version_manifest_v2.json'),
    JSON.stringify({ versions: [{ id: 'test-version', url: 'https://example.test/version' }] }),
  );
  await fs.writeFile(
    path.join(assets, 'test-version.json'),
    JSON.stringify({ downloads: { client: { url: 'https://example.test/client', sha1: 'unused' } } }),
  );
  const extract = await invoke(['assets', 'extract', '--version=test-version', '--dry-run'], options);
  assert.match(extract.stdout, /dry-run extract/);
  assert.ok(!extract.stdout.startsWith(version));
  await assert.rejects(
    invoke(['profile-mca', '--rounds', 'not-a-number', 'region.mca'], options),
    /expected a positive safe integer/,
  );
  assert.deepEqual((await fs.readdir(root)).sort(), ['cache']);
});
