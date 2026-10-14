import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { test } from 'node:test';

const execute = promisify(execFile);
test('relocated CLI works without server, TS sources, tsx, or native keyring; direct mode is opt-in', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-cli-artifact-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.bin, { 'violet-map': './dist/cli.js' });
  assert.equal(manifest.peerDependenciesMeta['@violet-map/server'].optional, true);
  await fs.cp(new URL('../dist/', import.meta.url), path.join(root, 'dist'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', version: manifest.version }));
  for (const name of Object.keys(manifest.dependencies)) {
    const destination = path.join(root, 'node_modules', name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (name === '@violet-map/core') {
      const core = new URL('../../core/', import.meta.url);
      await fs.mkdir(destination);
      await fs.cp(new URL('dist/', core), path.join(destination, 'dist'), { recursive: true });
      const metadata = JSON.parse(await fs.readFile(new URL('package.json', core), 'utf8'));
      await fs.writeFile(path.join(destination, 'package.json'), JSON.stringify(metadata));
      for (const dependency of Object.keys(metadata.dependencies)) {
        const dependencyPath = path.join(destination, 'node_modules', dependency);
        await fs.mkdir(path.dirname(dependencyPath), { recursive: true });
        await fs.symlink(await fs.realpath(new URL(`node_modules/${dependency}`, core)), dependencyPath, 'dir');
      }
    } else await fs.symlink(await fs.realpath(new URL(`../node_modules/${name}`, import.meta.url)), destination, 'dir');
  }
  const env = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' };
  for (const key of Object.keys(env)) if (/^(VIOLET_|DATABASE_|DATA_DIR$|ROOT_|S3_|AWS_)/.test(key)) delete env[key];
  const home = path.join(root, 'state');
  const args = [path.join(root, 'dist/cli.js'), '--cli-home', home];
  const run = (arguments_, overrides = {}) =>
    execute(process.execPath, [...args, ...arguments_], { cwd: root, env: { ...env, ...overrides }, timeout: 30_000 });
  assert.match((await run(['--help'], { VIOLET_MAP_CONFIG: '/not-a-server-config' })).stdout, /Violet Map tools/);
  assert.equal((await run(['--version'])).stdout.trim(), manifest.version);
  await assert.rejects(
    run(['users', 'list', '--via', 'database', '--database-dir', path.join(root, 'db')]),
    /requires @violet-map\/server/,
  );
  await assert.rejects(run(['db', 'migrate']));
  const credential = path.join(root, 'injected');
  await fs.writeFile(credential, 'artifact-token-value');
  await assert.rejects(run(['credentials', 'set', 'sample', '--file', credential]), /credential store/);
  await assert.rejects(fs.stat(path.join(home, 'credentials.json')), { code: 'ENOENT' });

  await fs.mkdir(home, { recursive: true });
  const oldId = '00000000-0000-0000-0000-000000000000';
  await fs.writeFile(
    path.join(home, 'state.json'),
    JSON.stringify({ version: 1, sessions: {}, secrets: { sample: { backend: 'keychain', id: oldId } } }),
    { mode: 0o600 },
  );
  const replaced = await run(['credentials', 'set', 'sample', '--file', credential, '--credential-store', 'file']);
  assert.match(replaced.stdout, /Saved credential/);
  assert.match(replaced.stderr, /old credential could not be removed/);
  const records = JSON.parse(await fs.readFile(path.join(home, 'state.json'), 'utf8')).secrets;
  assert.equal(records.sample.backend, 'file');
  assert.equal(records[`retired-${oldId}`].backend, 'keychain');
  assert.doesNotMatch(replaced.stdout + replaced.stderr, /artifact-token-value/);

  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer artifact-token-value');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify([{ username: 'remote_admin', role: 'admin', enabled: true }]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal(
    JSON.parse(
      (await run(['users', 'list'], { VIOLET_SERVER_URL: url, VIOLET_SERVER_TOKEN: 'artifact-token-value' })).stdout,
    )[0].username,
    'remote_admin',
  );
  const archive = path.join(root, 'archive');
  await fs.mkdir(archive);
  await fs.writeFile(path.join(archive, 'level.dat'), 'archive');
  await run([
    'world',
    'sync',
    '--from',
    archive,
    '--world',
    'survival',
    '--target',
    'local',
    '--target-dir',
    path.join(root, 'worlds'),
  ]);
  assert.equal(await fs.readFile(path.join(root, 'worlds/survival/level.dat'), 'utf8'), 'archive');

  const serverPackage = await fs.realpath(new URL('../../server/', import.meta.url));
  await fs.symlink(serverPackage, path.join(root, 'node_modules/@violet-map/server'), 'dir');
  const databaseDir = path.join(root, 'database');
  // DDL is exercised through the existing server artifact, never through violet-map.
  await execute(process.execPath, [path.join(serverPackage, 'dist/src/db/maintenance.js'), 'migrate'], {
    cwd: root,
    env: { ...env, DATABASE_DIR: databaseDir },
  });
  assert.deepEqual(
    JSON.parse((await run(['users', 'list', '--via', 'database', '--database-dir', databaseDir])).stdout),
    [],
  );
  assert.equal((await fs.readdir(root)).includes('database.lock'), false);
});
