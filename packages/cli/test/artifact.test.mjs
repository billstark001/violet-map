import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { test } from 'node:test';

const execute = promisify(execFile);

test('relocated CLI works without render/storage/server, TS sources, tsx, or native keyring; direct mode is opt-in', async (t) => {
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
      await fs.cp(new URL('data-defaults/', core), path.join(destination, 'data-defaults'), { recursive: true });
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

  const overlayFixture = path.join(root, 'overlay.json');
  await fs.writeFile(
    overlayFixture,
    JSON.stringify({ schemaVersion: 1, layerId: 'fixture', revision: 1, name: 'fixture', features: [] }),
  );
  assert.equal(JSON.parse((await run(['overlay', 'layer', 'validate', overlayFixture])).stdout).ok, true);
  const remoteFiles = new Map();
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer artifact-token-value');
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/violet/api/capabilities') {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          protocolVersion: 2,
          resourcesProtocol: 1,
          delivery: {
            mode: 'server',
            families: [
              'chunk',
              'texture',
              'atlas-image',
              'atlas-manifest',
              'asset-bundle',
              'game-data',
              'top-map-tile',
              'overlay-media',
            ],
          },
          adminApi: true,
          users: false,
          worldReads: true,
          worldWrites: true,
          dataWrites: false,
          diagnostics: false,
          authMode: 'static',
          contentReads: true,
          contentWrites: true,
        }),
      );
      return;
    }
    if (url.pathname === '/violet/api/admin/maps') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify([{ mapId: 'artifact-map', revision: 1 }]));
      return;
    }
    const prefix = '/violet/api/admin/storage/';
    if (url.pathname.startsWith(prefix)) {
      const route = url.pathname.slice(prefix.length);
      response.setHeader('content-type', 'application/json');
      if (route === 'list') {
        const directory = url.searchParams.get('prefix') || '';
        response.end(
          JSON.stringify(
            [...remoteFiles]
              .filter(([file]) => !directory || file.startsWith(directory + '/'))
              .map(([file, bytes]) => ({ path: file, size: bytes.length })),
          ),
        );
        return;
      }
      const file = decodeURIComponent(route.replace(/^(files|stat)\//, ''));
      if (request.method === 'PUT') {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
          remoteFiles.set(file, Buffer.concat(chunks));
          response.end('{"ok":true}');
        });
        return;
      }
      const bytes = remoteFiles.get(file);
      if (!bytes) {
        response.writeHead(404).end();
        return;
      }
      if (route.startsWith('stat/')) response.end(JSON.stringify({ path: file, size: bytes.length }));
      else response.end(bytes);
      return;
    }
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
  assert.equal(
    JSON.parse(
      (await run(['map', 'list'], { VIOLET_SERVER_URL: url + '/violet/', VIOLET_SERVER_TOKEN: 'artifact-token-value' }))
        .stdout,
    )[0].mapId,
    'artifact-map',
  );
  const archive = path.join(root, 'archive');
  await fs.mkdir(archive);
  await fs.writeFile(path.join(archive, 'level.dat'), 'archive');
  for (const command of [
    ['bake-topmap', '--help'],
    ['profile-mca', '--help'],
    ['world', 'sync', '--help'],
    ['assets', '--help'],
    ['config', 'show'],
    ['profile', 'list'],
  ])
    await run(command);
  await assert.rejects(run(['bake-topmap', archive]), /requires @violet-map\/render/);
  await assert.rejects(
    run([
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
    ]),
    /requires @violet-map\/storage/,
  );
  await assert.rejects(fs.stat(path.join(archive, '.violet-map')), { code: 'ENOENT' });
  async function installCapability(name) {
    const source = new URL(`../../${name}/`, import.meta.url);
    const destination = path.join(root, 'node_modules/@violet-map', name);
    await fs.mkdir(destination);
    await fs.cp(new URL('dist/', source), path.join(destination, 'dist'), { recursive: true });
    if (name === 'resources')
      await fs.cp(new URL('data-defaults/', source), path.join(destination, 'data-defaults'), { recursive: true });
    const metadata = JSON.parse(await fs.readFile(new URL('package.json', source), 'utf8'));
    await fs.writeFile(path.join(destination, 'package.json'), JSON.stringify(metadata));
    for (const dependency of Object.keys(metadata.dependencies)) {
      if (dependency.startsWith('@violet-map/')) continue;
      const nested = path.join(destination, 'node_modules', dependency);
      await fs.mkdir(path.dirname(nested), { recursive: true });
      await fs.symlink(await fs.realpath(new URL(`node_modules/${dependency}`, source)), nested, 'dir');
    }
    return destination;
  }
  await installCapability('render');
  await assert.rejects(run(['bake-topmap', archive]), /requires @violet-map\/resources/);
  await installCapability('storage');
  await installCapability('resources');
  await run(['bake-topmap', archive, '--out', path.join(root, 'topmap')]);
  const renderEntry = path.join(root, 'node_modules/@violet-map/render/dist/index.js');
  const originalRender = await fs.readFile(renderEntry, 'utf8');
  await fs.appendFile(renderEntry, '\nthrow new Error("installed render implementation failed");\n');
  await assert.rejects(run(['bake-topmap', archive]), (error) => {
    assert.match(error.stderr, /installed render implementation failed/);
    assert.doesNotMatch(error.stderr, /requires @violet-map\/render/);
    return true;
  });
  await fs.writeFile(renderEntry, originalRender);
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
  await assert.rejects(fs.stat(path.join(root, 'node_modules/@violet-map/server')), { code: 'ENOENT' });
  await run(['world', 'sync', '--from', archive, '--world', 'survival', '--target', 'server'], {
    VIOLET_SERVER_URL: url + '/violet/',
    VIOLET_SERVER_TOKEN: 'artifact-token-value',
  });
  assert.equal(remoteFiles.get('survival/level.dat').toString(), 'archive');
  assert.ok(remoteFiles.has('survival/.violet-map/identity.json'));
  assert.match(
    (
      await run(['world', 'sync', '--from', archive, '--world', 'survival', '--target', 'server'], {
        VIOLET_SERVER_URL: url + '/violet/',
        VIOLET_SERVER_TOKEN: 'artifact-token-value',
      })
    ).stdout,
    /1 copied, 1 unchanged/,
  );

  const serverPackage = await installCapability('server');
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
