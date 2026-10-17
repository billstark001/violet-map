import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import type { OverlayMediaReference } from '../../packages/core/src/overlayTypes.js';

test(
  'real browser public-media CORS, pinned integrity, proxy fallback and credential isolation',
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
            return new Response(null, { status: 404, headers: { 'access-control-allow-origin': '*' } });
          requests.push({
            path: `${kind}${path}`,
            authorization: request.headers.get('authorization'),
            cookie: request.headers.get('cookie'),
          });
          const headers: Record<string, string> =
            kind === 'api' || path !== '/blocked' ? { 'access-control-allow-origin': '*' } : {};
          return new Response(path === '/corrupt' ? new Uint8Array([4, 5, 6]) : bytes, { headers });
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
    t.after(() => {
      vite.kill('SIGTERM');
    });
    stage = 'starting Vite';
    const origin = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Vite startup timed out: ${diagnostics.join('\n')}`)), 15_000);
      let output = '';
      vite.stderr.on('data', (bytes) => diagnostics.push(String(bytes)));
      vite.stdout.on('data', (bytes) => {
        diagnostics.push(String(bytes));
      });
      vite.stdout.on('data', (bytes) => {
        output += String(bytes);
        const match = stripVTControlCharacters(output).match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[0]);
        }
      });
      vite.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      vite.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Vite exited ${code}`));
      });
    });
    stage = 'launching browser';
    const browser = await chromium.launch({
      timeout: 15_000,
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
        (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined),
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
    await page.goto(`${origin}/test/media-delivery-browser.html?api=${encodeURIComponent(origins[1] + '/violet/')}`);
    await page.waitForFunction(
      () => typeof (window as unknown as { readPinnedMedia?: unknown }).readPinnedMedia === 'function',
    );
    const read = (reference: OverlayMediaReference) =>
      page.evaluate(
        (reference) =>
          (
            window as unknown as { readPinnedMedia: (reference: OverlayMediaReference) => Promise<number[]> }
          ).readPinnedMedia(reference),
        reference,
      );
    const reference: OverlayMediaReference = {
      version: {
        schemaVersion: 1,
        assetId: 'a',
        versionId: digest,
        digest,
        bytes: 3,
        mediaType: 'image/png',
        width: 1,
        height: 1,
        dependencies: [],
        blob: `sha256/${digest.slice(0, 2)}/${digest}`,
      },
      url: '/api/maps/m/media/a/v',
      publicUrl: `${origins[0]}/ok`,
    };
    stage = 'fetching public bytes';
    assert.deepEqual(await read(reference), [...bytes]);
    assert.deepEqual(
      requests.map((r) => r.path),
      ['public/ok'],
    );
    for (const path of ['blocked', 'corrupt']) {
      stage = `fetching fallback for ${path}`;
      requests.length = 0;
      assert.deepEqual(await read({ ...reference, publicUrl: `${origins[0]}/${path}` }), [...bytes]);
      assert.deepEqual(
        requests.map((r) => r.path),
        [`public/${path}`, 'api/violet/api/maps/m/media/a/v'],
      );
    }
    stage = 'checking credentials';
    assert.ok(
      requests.every((r) => !r.authorization && !r.cookie),
      JSON.stringify(requests),
    );
    completed = true;
  },
);
