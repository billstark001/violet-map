import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const project = fileURLToPath(new URL('../../', import.meta.url));
const cleanEnv = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' };
for (const key of Object.keys(cleanEnv))
  if (
    /^(VIOLET_|DATABASE_|ROOT_|S3_|AWS_|DEPLOYMENT_|AUTH_|STATIC_|USERS_|ADMIN_|WORLD_|WORLDS_|DATA_|ASSETS_|MC_|CACHE_|PORT$)/.test(
      key,
    )
  )
    delete cleanEnv[key];

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function boot(artifact, env, cwd) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(artifact, 'dist/src/index.js')], {
    cwd,
    env: { ...cleanEnv, ...env, PORT: String(port), CACHE_PREWARM: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (bytes) => {
    output += bytes;
  });
  child.stderr.on('data', (bytes) => {
    output += bytes;
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(output || 'startup timeout'));
    }, 20_000);
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(output));
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on('data', (bytes) => {
      if (String(bytes).includes('server on')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const stopped = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await stopped;
      clearTimeout(timer);
      assert.equal(child.exitCode, 0, output);
    },
  };
}

test('server production deployment is self-contained; public/sync/full and startup failure release resources', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-production-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifact = path.join(root, 'server');
  await execute('pnpm', ['--filter', '@violet-map/server', 'deploy', '--legacy', '--prod', artifact], {
    cwd: project,
    timeout: 120_000,
    maxBuffer: 4 * 1024 ** 2,
  });
  const canonicalArtifact = await fs.realpath(artifact);
  const work = path.join(root, 'unrelated-cwd');
  await fs.mkdir(work);
  for (const name of ['tsx', 'typescript', 'vite', '@violet-map/render', '@violet-map/web', '@violet-map/admin'])
    await assert.rejects(fs.stat(path.join(artifact, 'node_modules', name)), { code: 'ENOENT' });
  for (const name of ['server', 'core', 'storage']) {
    const location = name === 'server' ? artifact : path.join(artifact, 'node_modules/@violet-map', name);
    await assert.rejects(fs.stat(path.join(location, 'src')), { code: 'ENOENT' });
    const manifest = JSON.parse(await fs.readFile(path.join(location, 'package.json'), 'utf8'));
    for (const entry of Object.values(manifest.exports))
      for (const condition of ['default', 'types'])
        assert.ok((await fs.stat(path.join(location, entry[condition]))).isFile());
  }
  async function checkLinks(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) assert.ok((await fs.realpath(file)).startsWith(canonicalArtifact + path.sep), file);
      else if (entry.isDirectory()) await checkLinks(file);
    }
  }
  await checkLinks(artifact);
  await execute(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    for (const entry of ['@violet-map/core/mesher', '@violet-map/server/contracts'])
      await assert.rejects(import(entry), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    const core = await import('@violet-map/core');
    for (const name of ['ModelBaker', 'meshSection', 'computeColumnLight', 'CameraGridTracker', 'LocalWorldStorage'])
      assert.equal(name in core, false, name);
    const storage = await import('@violet-map/core/storage');
    assert.deepEqual(Object.keys(storage), []);
  `,
    ],
    { cwd: artifact, env: cleanEnv },
  );
  await execute(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await Promise.all(['app','services','configuration','admin'].map(name => import(${JSON.stringify(artifact)} + '/dist/src/' + name + '.js')))`,
    ],
    { cwd: work, env: { ...cleanEnv, VIOLET_MAP_CONFIG: '/missing/config.yaml' } },
  );
  assert.deepEqual(await fs.readdir(work), []);

  for (const profile of ['public', 'sync', 'full']) {
    const data = path.join(root, profile);
    const env = {
      DEPLOYMENT_PROFILE: profile,
      DATA_DIR: data,
      WORLDS_DIR: path.join(data, 'worlds'),
      DATABASE_DIR: path.join(data, 'users.pglite'),
      STATIC_API_TOKEN: 'production-service-token',
      ROOT_USERNAME: 'operator',
      ROOT_PASSWORD: 'production-root-password',
    };
    if (profile === 'full') {
      await assert.rejects(boot(artifact, env, work), /Run server db:migrate/);
      await assert.rejects(fs.stat(env.DATABASE_DIR + '.lock'), { code: 'ENOENT' });
      const result = await execute(process.execPath, [path.join(artifact, 'dist/src/db/maintenance.js'), 'migrate'], {
        cwd: work,
        env: { ...cleanEnv, ...env },
      });
      assert.equal(JSON.parse(result.stdout).state, 'current');
    }
    const server = await boot(artifact, env, work);
    t.after(() => server.close());
    const request = (url, init) => fetch(server.url + url, init);
    const caps = await (await request('/api/capabilities')).json();
    assert.equal(caps.authMode, { public: 'none', sync: 'static', full: 'users' }[profile]);
    assert.deepEqual(await (await request('/api/worlds')).json(), []);
    assert.ok(Object.keys(await (await request('/api/data/biomes')).json()).length > 0);
    const bundle = await (await request('/api/assets/bundle')).json();
    assert.ok(bundle.models['minecraft:violet_map/block_entity/chest']);
    if (profile !== 'full') {
      await assert.rejects(fs.stat(env.DATABASE_DIR), { code: 'ENOENT' });
      assert.equal((await request('/api/auth/login', { method: 'POST' })).status, 404);
    }
    if (profile === 'public') {
      assert.equal(
        (await request('/api/admin/storage/list', { headers: { authorization: 'Bearer production-service-token' } }))
          .status,
        404,
      );
      await assert.rejects(fs.stat(data), { code: 'ENOENT' });
    } else {
      let token = env.STATIC_API_TOKEN;
      if (profile === 'full') {
        const login = await request('/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: env.ROOT_USERNAME, password: env.ROOT_PASSWORD }),
        });
        assert.equal(login.status, 200);
        token = (await login.json()).token;
      }
      assert.equal((await request('/api/admin/storage/list')).status, 401);
      assert.equal(
        (await request('/api/admin/storage/list', { headers: { authorization: `Bearer ${token}` } })).status,
        200,
      );
      if (profile === 'full') {
        assert.equal(
          (await request('/api/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status,
          200,
        );
        assert.equal((await request('/api/auth/me', { headers: { authorization: `Bearer ${token}` } })).status, 401);
      }
    }
    await server.close();
    await assert.rejects(fs.stat(env.DATABASE_DIR + '.lock'), { code: 'ENOENT' });
    if (profile === 'full') {
      const occupied = net.createServer();
      await new Promise((resolve) => occupied.listen(0, resolve));
      try {
        await assert.rejects(
          execute(process.execPath, [path.join(artifact, 'dist/src/index.js')], {
            cwd: work,
            env: { ...cleanEnv, ...env, PORT: String(occupied.address().port) },
            timeout: 20_000,
          }),
          /EADDRINUSE/,
        );
        await assert.rejects(fs.stat(env.DATABASE_DIR + '.lock'), { code: 'ENOENT' });
      } finally {
        await new Promise((resolve) => occupied.close(resolve));
      }
    }
  }
});

test('packed library/CLI exports exist and workspace versions are converted for publication', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-pack-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ['core', 'render', 'storage', 'server', 'cli']) {
    const archive = path.join(root, name + '.tgz');
    await execute('pnpm', ['pack', '--out', archive], { cwd: path.join(project, 'packages', name) });
    const unpack = path.join(root, name);
    await fs.mkdir(unpack);
    await execute('tar', ['-xzf', archive, '-C', unpack]);
    const directory = path.join(unpack, 'package');
    const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
    for (const group of ['dependencies', 'peerDependencies'])
      for (const version of Object.values(metadata[group] ?? {})) assert.ok(!version.startsWith('workspace:'));
    for (const entry of Object.values(metadata.exports ?? {}))
      for (const condition of ['default', 'types'])
        assert.ok((await fs.stat(path.join(directory, entry[condition]))).isFile());
    for (const bin of Object.values(metadata.bin ?? {})) assert.ok((await fs.stat(path.join(directory, bin))).isFile());
    await assert.rejects(fs.stat(path.join(directory, 'src')), { code: 'ENOENT' });
  }
  for (const name of ['web', 'admin']) {
    const assets = path.join(project, 'packages', name, 'dist/assets');
    for (const file of await fs.readdir(assets))
      if (file.endsWith('.js'))
        assert.doesNotMatch(
          await fs.readFile(path.join(assets, file), 'utf8'),
          /@aws-sdk|@electric-sql\/pglite|drizzle-orm|node:fs/,
        );
  }
});
