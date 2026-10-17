import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
const docker = async (...args) =>
  (await execute('docker', args, { timeout: 60_000, maxBuffer: 2 * 1024 ** 2 })).stdout.trim();
const image = (service) => `violet-acceptance-${service}`;

async function launch(t, service, port, env = {}, command = []) {
  const id = await docker(
    'run',
    '--detach',
    '--publish',
    `127.0.0.1::${port}`,
    ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    image(service),
    ...command,
  );
  t.after(() => docker('rm', '--force', id));
  const mapping = await docker('port', id, `${port}/tcp`);
  const origin = `http://${mapping}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(origin + (service === 'server' ? '/api/capabilities' : '/runtime-config.json'), {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return { id, origin };
    } catch {
      /* Wait for this container's listener. */
    }
    if ((await docker('inspect', '--format', '{{.State.Running}}', id)) !== 'true')
      throw new Error(await docker('logs', id));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`container startup timeout: ${await docker('logs', id)}`);
}

test('production containers run independently with only their own artifacts', async (t) => {
  const unreachable = 'https://external-api.example.invalid/violet/';
  for (const service of ['web', 'admin']) {
    const container = await launch(t, service, service === 'web' ? 3305 : 3310, { API_BASE_URL: unreachable });
    assert.deepEqual(await (await fetch(container.origin + '/runtime-config.json')).json(), {
      apiBaseUrl: unreachable,
      capabilityFallback: 'legacy',
    });
    assert.equal((await fetch(container.origin + '/runtime-config.json')).headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(container.origin + '/brand/violet-map-icon.svg')).status, 200);
    const html = await (await fetch(container.origin)).text();
    assert.match(html, /Violet Map/);
    await docker(
      'exec',
      container.id,
      'sh',
      '-c',
      'test ! -e /app/node_modules && test ! -e /app/src && test -f /app/serve.mjs',
    );
  }
  await docker(
    'run',
    '--rm',
    '--env',
    'VIOLET_MAP_CONFIG=/missing/config.yaml',
    image('server'),
    'node',
    '--input-type=module',
    '-e',
    "await Promise.all(['app','services','configuration','admin'].map(name => import('./dist/src/' + name + '.js')))",
  );
  for (const profile of ['public', 'sync', 'full']) {
    const container = await launch(
      t,
      'server',
      3300,
      {
        DEPLOYMENT_PROFILE: profile,
        CACHE_PREWARM: 'false',
        STATIC_API_TOKEN: 'container-test-token',
        ROOT_USERNAME: 'operator',
        ROOT_PASSWORD: 'container-test-password',
        ...(profile === 'sync' ? { CONTENT_READS_ENABLED: 'true', CONTENT_WRITES_ENABLED: 'true' } : {}),
      },
      profile === 'full' ? ['sh', '-c', 'node dist/src/db/maintenance.js migrate && exec node dist/src/index.js'] : [],
    );
    const request = (path, init) => fetch(container.origin + path, init);
    const caps = await (await request('/api/capabilities')).json();
    assert.equal(caps.authMode, { public: 'none', sync: 'static', full: 'users' }[profile]);
    assert.ok(Object.keys(await (await request('/api/data/biomes')).json()).length > 0);
    const bundle = await (await request('/api/assets/bundle')).json();
    assert.ok(bundle.models['minecraft:violet_map/block_entity/chest']);
    await docker(
      'exec',
      container.id,
      'sh',
      '-c',
      'test ! -e /app/src && test ! -e /app/node_modules/tsx && test ! -e /app/node_modules/typescript && test ! -e /app/node_modules/@violet-map/web && test ! -e /app/node_modules/@violet-map/admin && test ! -e /app/node_modules/@violet-map/render',
    );
    if (profile !== 'full') {
      await docker(
        'exec',
        container.id,
        'sh',
        '-c',
        'test ! -e /data/users.pglite && test ! -e /data/users.pglite.lock',
      );
      assert.equal((await request('/api/auth/login', { method: 'POST' })).status, 404);
    }
    if (profile === 'sync') {
      const json = async (url, body, revision) => {
        const response = await request(url, {
          method: revision ? 'PUT' : 'POST',
          headers: {
            authorization: 'Bearer container-test-token',
            'content-type': 'application/json',
            ...(revision ? { 'if-match': `"${revision}"` } : {}),
          },
          body: JSON.stringify(body),
        });
        assert.ok(response.ok, await response.clone().text());
        return response.json();
      };
      await json('/api/admin/worlds', { world: 'overlay' });
      const map = await json('/api/admin/maps', { name: 'container', worldKey: 'overlay' });
      const layer = await json('/api/admin/overlays/layers', {
        schemaVersion: 1,
        layerId: 'input',
        revision: 1,
        name: 'container',
        features: [],
      });
      await json(
        `/api/admin/maps/${map.mapId}/bindings/main`,
        { bindingId: 'main', layerId: layer.layerId, dimension: 'overworld', enabled: true, order: 0 },
        1,
      );
      const manifest = await (await request(`/api/maps/${map.mapId}/overlays?dimension=overworld`)).json();
      assert.equal(manifest.layers.length, 1);
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8H0z"/></svg>';
      const imported = await request('/api/admin/media?name=container', {
        method: 'POST',
        headers: { authorization: 'Bearer container-test-token', 'content-type': 'image/svg+xml' },
        body: svg,
      });
      assert.equal(imported.status, 201);
      const { document, version } = await imported.json();
      const range = await request(`/api/admin/media/${document.assetId}/versions/${version.versionId}/file`, {
        headers: { authorization: 'Bearer container-test-token', range: 'bytes=0-3' },
      });
      assert.equal(range.status, 206);
      assert.equal(await range.text(), '<svg');
    }
    let token = 'container-test-token';
    if (profile === 'full') {
      const response = await request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'operator', password: 'container-test-password' }),
      });
      assert.equal(response.status, 200);
      token = (await response.json()).token;
    }
    assert.equal(
      (await request('/api/admin/storage/list', { headers: { authorization: `Bearer ${token}` } })).status,
      profile === 'public' ? 404 : 200,
    );
    if (profile === 'full') {
      assert.equal(
        (await request('/api/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status,
        200,
      );
      assert.equal((await request('/api/auth/me', { headers: { authorization: `Bearer ${token}` } })).status, 401);
    }
    await docker('stop', '--time', '15', container.id);
    assert.equal(await docker('inspect', '--format', '{{.State.ExitCode}}', container.id), '0');
  }
});
