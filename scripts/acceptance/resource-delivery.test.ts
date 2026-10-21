import { chromiumExecutablePath } from '../helpers/browser.mjs';
import { stopProcess, waitForProcessOutput } from '../helpers/process.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import type { ResourceRef, ResourceKind } from '../../packages/core/src/resources.js';

test(
  'real browser unified resource CORS, integrity, strict failures and credential isolation',
  { timeout: 60_000 },
  async (t) => {
    let stage = 'starting servers';
    let completed = false;
    const diagnostics: string[] = [];
    t.after(() => {
      if (!completed) t.diagnostic(JSON.stringify({ stage, diagnostics }));
    });
    const bytes = new Uint8Array([1, 2, 3]);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const requests: { path: string; authorization: string | null; cookie: string | null }[] = [];
    const servers = ['public', 'api'].map((kind) =>
      serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch: (request) => {
          const path = new URL(request.url).pathname;
          if (path.endsWith('/capabilities'))
            return Response.json(
              {
                protocolVersion: 2,
                resourcesProtocol: 1,
                delivery: {
                  mode: 'public',
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
                adminApi: false,
                users: false,
                worldReads: false,
                worldWrites: false,
                dataWrites: false,
                contentReads: false,
                contentWrites: false,
                diagnostics: false,
                authMode: 'none',
              },
              { headers: { 'access-control-allow-origin': '*' } },
            );
          requests.push({
            path: `${kind}${path}`,
            authorization: request.headers.get('authorization'),
            cookie: request.headers.get('cookie'),
          });
          const headers: Record<string, string> =
            kind === 'api' || path !== '/blocked' ? { 'access-control-allow-origin': '*' } : {};
          return new Response(path === '/corrupt' ? new Uint8Array([4, 5, 6]) : bytes, {
            headers: { ...headers, 'content-type': 'application/octet-stream' },
          });
        },
      }),
    );
    t.after(async () => {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
              if ('closeAllConnections' in server) server.closeAllConnections();
            }),
        ),
      );
    });
    await Promise.all(
      servers.map((server) =>
        server.listening ? Promise.resolve() : new Promise((resolve) => server.once('listening', resolve)),
      ),
    );
    const origins = servers.map((server) => `http://127.0.0.1:${(server.address() as { port: number }).port}`);
    const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '0'], {
      cwd: fileURLToPath(new URL('../../packages/web/', import.meta.url)),
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => stopProcess(vite));
    stage = 'starting Vite';
    vite.stderr.on('data', (bytes) => diagnostics.push(String(bytes)));
    vite.stdout.on('data', (bytes) => diagnostics.push(String(bytes)));
    const [origin] = await waitForProcessOutput(vite, /http:\/\/127\.0\.0\.1:\d+(?=\/|\s)/, 'Vite');
    stage = 'launching browser';
    const browser = await chromium.launch({
      timeout: 15_000,
      executablePath: chromiumExecutablePath(),
      headless: true,
    });
    t.after(() => browser.close());
    const context = await browser.newContext();
    await context.addCookies([{ name: 'private-session', value: 'must-not-leak', url: origins[0] }]);
    const page = await context.newPage();
    page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') diagnostics.push(`console: ${message.text()}`);
    });
    page.on('requestfailed', (request) =>
      diagnostics.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`),
    );
    stage = 'loading browser module';
    page.setDefaultTimeout(15_000);
    await page.goto(`${origin}/test/resource-delivery-browser.html?api=${encodeURIComponent(origins[1] + '/violet/')}`);
    await page.waitForFunction(
      () => typeof (window as unknown as { readResource?: unknown }).readResource === 'function',
    );
    const read = (reference: ResourceRef) =>
      page.evaluate(
        (reference) =>
          (window as unknown as { readResource: (reference: ResourceRef) => Promise<number[]> }).readResource(
            reference,
          ),
        reference,
      );
    for (const kind of ['chunk', 'atlas-image', 'top-map-tile', 'overlay-media'] as ResourceKind[]) {
      const reference: ResourceRef = {
        schemaVersion: 1,
        kind,
        artifact: { digest, bytes: 3, mediaType: 'application/octet-stream', format: 'test-v1' },
        url: `${origins[0]}/ok`,
      };
      stage = `fetching ${kind}`;
      requests.length = 0;
      assert.deepEqual(await read(reference), [...bytes]);
      assert.deepEqual(
        requests.map((r) => r.path),
        ['public/ok'],
      );
      for (const path of ['blocked', 'corrupt']) {
        requests.length = 0;
        stage = `rejecting ${kind} ${path}`;
        await assert.rejects(read({ ...reference, url: `${origins[0]}/${path}` }));
        assert.deepEqual(
          requests.map((r) => r.path),
          [`public/${path}`],
        );
      }
    }
    stage = 'checking credentials';
    assert.ok(
      requests.every((r) => !r.authorization && !r.cookie),
      JSON.stringify(requests),
    );
    completed = true;
  },
);

test(
  'four real published families are read directly by a source-free reader and browser; a pose edit uploads no bodies',
  { timeout: 120000 },
  async (t) => {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const { LocalStorage } = await import('../../packages/storage/src/local.js');
    const { resourceFixture } = await import('./helpers/resources.js');
    const { loadServerConfig } = await import('../../packages/server/src/configuration.js');
    const { createServices } = await import('../../packages/server/src/services.js');
    const { createApp } = await import('../../packages/server/src/app.js');
    const { closeServer, serverOrigin } = await import('./helpers/frontend.js');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-four-families-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const fixture = await resourceFixture(root);
    const target = new LocalStorage(root);
    let publicRequests = 0;
    const publicServer = serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        publicRequests++;
        const key = new URL(request.url).pathname.slice(1);
        if (!key.startsWith('public/objects/')) return new Response(null, { status: 404 });
        const [bytes, metadata] = await Promise.all([target.read(key), target.httpMetadata(key)]);
        return bytes && metadata
          ? new Response(request.method === 'HEAD' ? null : (bytes as BodyInit), {
              headers: {
                'content-type': metadata.contentType,
                'cache-control': metadata.cacheControl!,
                'content-length': String(bytes.length),
                'access-control-allow-origin': '*',
              },
            })
          : new Response(null, { status: 404 });
      },
    });
    t.after(() => closeServer(publicServer));
    const publicOrigin = await serverOrigin(publicServer);
    const file = path.join(root, 'publisher.json');
    const settings = {
      deployment: { profile: 'sync' },
      features: { contentReads: true, contentWrites: true },
      storage: {
        backends: { data: { driver: 'local', root } },
        mounts: {
          worlds: { backend: 'data', prefix: 'worlds' },
          content: { backend: 'data', prefix: 'content' },
          blobs: { backend: 'data', prefix: 'blobs' },
        },
      },
      assets: { dirs: [fixture.assets] },
      resources: {
        roles: ['serve', 'publish'],
        cache: { memoryBytes: 0 },
        delivery: {
          mode: 'public',
          targetMount: { backend: 'data', prefix: 'public' },
          publicBaseUrl: publicOrigin + '/public/',
        },
        publication: { storeMount: { backend: 'data', prefix: 'control' }, debounceMs: 60000, maxDelayMs: 60000 },
      },
    };
    await fs.writeFile(file, JSON.stringify(settings));
    const writer = await createServices(
      loadServerConfig({ configFile: file, env: { STATIC_API_TOKEN: 'fixture-token' }, cwd: root }),
    );
    t.after(() => writer.close());
    const media = await writer.content!.importMedia(fixture.pngBytes, 'image/png', 'fixture');
    const layer = await writer.content!.createLayer({
      schemaVersion: 1,
      layerId: 'input',
      revision: 1,
      name: 'fixture',
      features: [
        {
          featureId: 'image',
          kind: 'media',
          assetId: media.document.assetId,
          versionId: media.version.versionId,
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
          views: ['top', 'player'],
          placement: 'plane',
          size: [2, 2],
          anchor: [0.5, 0.5],
        },
      ],
    });
    const map = await writer.content!.createMap({ name: 'fixture', worldKey: 'fixture' });
    await writer.content!.setBinding(
      map.mapId,
      'main',
      { bindingId: 'main', layerId: layer.layerId, dimension: 'minecraft:overworld', enabled: true, order: 0 },
      map.revision,
    );
    const first = await writer.resources.publication.publish(null);
    const before = {
      generated: writer.resources.repository!.metrics.generation,
      uploaded: writer.resources.target!.metrics.uploadedBytes,
    };
    const feature = layer.features[0];
    await writer.content!.replaceLayer(
      layer.layerId,
      { ...layer, revision: 2, features: [{ ...feature, position: [2, 0, 0] }] },
      layer.revision,
    );
    const second = await writer.resources.publication.publish(first.publicationId);
    assert.notEqual(second.publicationId, first.publicationId);
    assert.equal(writer.resources.repository!.metrics.generation, before.generated);
    assert.equal(writer.resources.target!.metrics.uploadedBytes, before.uploaded);
    await writer.close();
    settings.deployment.profile = 'public';
    settings.features = { contentReads: false, contentWrites: false };
    settings.resources.roles = ['serve'];
    await fs.writeFile(file, JSON.stringify(settings));
    const config = loadServerConfig({ configFile: file, env: {}, cwd: root });
    const reader = await createServices(config);
    t.after(() => reader.close());
    assert.equal(reader.worldStore, undefined);
    assert.equal(reader.resources.repository, undefined);
    const app = createApp(config, reader);
    let apiBodies = 0;
    const api = serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) => {
        if (/\/api\/resources\/[^/]+\/[^/]+\/[^/]+$/.test(new URL(request.url).pathname)) apiBodies++;
        return app.fetch(request);
      },
    });
    t.after(() => closeServer(api));
    const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '0'], {
      cwd: fileURLToPath(new URL('../../packages/web/', import.meta.url)),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => stopProcess(vite));
    const [origin] = await waitForProcessOutput(vite, /http:\/\/127\.0\.0\.1:\d+(?=\/|\s)/, 'Vite');
    const browser = await chromium.launch({
      executablePath: chromiumExecutablePath(),
      headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(`${origin}/test/resource-delivery-browser.html?api=${encodeURIComponent(await serverOrigin(api))}`);
    await page.waitForFunction(() => typeof (window as any).readPublication === 'function');
    publicRequests = 0;
    const result = await page.evaluate(
      async (args) => (window as any).readPublication(...args),
      [map.mapId, media.document.assetId, media.version.versionId],
    );
    assert.equal(result.viewId, second.publicationId);
    assert.deepEqual(result.formats, ['chunk-msgpack-v1', 'atlas-manifest-v1', 'png', 'topmap-msgpack-v6', 'png']);
    assert.equal(apiBodies, 0);
    assert.equal(publicRequests, 5);
  },
);
