import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createApp } from '../src/app.js';
import { createServices } from '../src/services.js';
import { loadServerConfig } from '../src/configuration.js';
const execute = promisify(execFile);
test('CLI alone completes content lifecycle with API prefix, credentials and explicit conflicts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-content-cli-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = loadServerConfig({
    env: {
      DEPLOYMENT_PROFILE: 'sync',
      STATIC_API_TOKEN: 'cli-token',
      CONTENT_READS_ENABLED: 'true',
      CONTENT_WRITES_ENABLED: 'true',
      DATA_DIR: root,
      WORLDS_DIR: path.join(root, 'worlds'),
    },
    cwd: root,
  });
  const services = await createServices(config);
  t.after(() => services.close());
  await services.mounts.worlds.write('world/level.dat', new Uint8Array([1]));
  const app = new Hono();
  app.route('/prefix', createApp(config, services));
  const server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('invalid address');
  const env = {
    ...process.env,
    VIOLET_SERVER_URL: `http://localhost:${address.port}/prefix/`,
    VIOLET_SERVER_TOKEN: 'cli-token',
  };
  const run = async (args: string[]) =>
    JSON.parse(
      (
        await execute(
          process.execPath,
          [
            '--import',
            'tsx',
            '--conditions=development',
            'packages/cli/src/cli.ts',
            '--cli-home',
            path.join(root, 'cli'),
            ...args,
          ],
          { env },
        )
      ).stdout,
    );
  const doc = {
    schemaVersion: 1,
    layerId: 'original',
    revision: 1,
    name: 'curves',
    features: [
      {
        featureId: 'curve',
        kind: 'curve',
        nodes: [
          { anchor: [0, 64, 0], in: [0, 0, 0], out: [10, 5, 0] },
          { anchor: [20, 64, 20], in: [-5, 0, 0], out: [0, 0, 0] },
        ],
        closed: false,
        style: { color: '#aa44ff', opacity: 0.5, width: 2, widthUnit: 'blocks' },
      },
    ],
  };
  const file = path.join(root, 'layer.json');
  await fs.writeFile(file, JSON.stringify(doc));
  assert.equal((await run(['overlay', 'layer', 'validate', file])).ok, true);
  const map = await run(['map', 'register', '--world', 'world', '--name', 'map']);
  const svg = path.join(root, 'marker.svg');
  await fs.writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 4"><path d="M0 0h8v4H0z"/></svg>');
  const asset = await run(['media', 'import', svg]);
  assert.equal((await run(['media', 'versions', asset.document.assetId])).length, 1);
  const layer = await run(['overlay', 'layer', 'import', file]);
  assert.equal(
    (
      await run([
        'overlay',
        'bind',
        '--map',
        map.mapId,
        '--binding',
        'main',
        '--layer',
        layer.layerId,
        '--dimension',
        'overworld',
        '--if-match',
        '1',
      ])
    ).revision,
    2,
  );
  const manifest = await run(['overlay', 'manifest', '--map', map.mapId, '--dimension', 'overworld']);
  assert.equal(manifest.layers[0].document.layerId, layer.layerId);
  const exported = path.join(root, 'export.json');
  await run(['overlay', 'layer', 'export', layer.layerId, '--output', exported]);
  assert.deepEqual(JSON.parse(await fs.readFile(exported, 'utf8')).features, doc.features);
  const independent = await run(['overlay', 'layer', 'import', exported]);
  assert.notEqual(independent.layerId, layer.layerId);
  assert.equal((await run(['overlay', 'layer', 'replace', layer.layerId, exported, '--if-match', '1'])).revision, 2);
  await assert.rejects(run(['overlay', 'layer', 'replace', layer.layerId, exported, '--if-match', '1']), /HTTP 412/);
  await run(['overlay', 'unbind', '--map', map.mapId, '--binding', 'main', '--if-match', '2']);
  assert.deepEqual(await run(['overlay', 'bindings', '--map', map.mapId]), []);
  await run(['overlay', 'layer', 'delete', layer.layerId, '--if-match', '2']);
  await run(['media', 'delete', asset.document.assetId, '--if-match', '1']);
});
