import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import { createApp } from '../../packages/server/src/app.js';
import { createServices } from '../../packages/server/src/services.js';
import { loadServerConfig } from '../../packages/server/src/configuration.js';

const project = fileURLToPath(new URL('../../', import.meta.url));
const close = (server: ReturnType<typeof serve>) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    if ('closeAllConnections' in server) server.closeAllConnections();
  });
async function origin(server: ReturnType<typeof serve>) {
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function staticSite(root: string, name: 'web' | 'admin', base: string, api: string) {
  const dist = path.join(root, name);
  await fs.cp(path.join(project, 'packages', name, 'dist'), dist, { recursive: true });
  const child = spawn(process.execPath, [path.join(dist, 'serve.mjs'), '0', api], {
    env: { ...process.env, PORT: '0', STATIC_BASE_PATH: base, API_BASE_URL: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout.on('data', (bytes) => {
      const match = String(bytes).match(/:(\d+)/);
      if (match) resolve(Number(match[1]));
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`static site exited ${code}`)));
  });
  return { url: `http://127.0.0.1:${port}${base}`, dist, child };
}

test('three origins: static prefixes, CORS pixels/WebGL, uploads, capabilities and token isolation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-frontend-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { PNG } = createRequire(new URL('../../packages/server/package.json', import.meta.url))('pngjs');
  const assetsDir = path.join(root, 'assets');
  for (const [name, size] of [
    ['block/stone', 16],
    ['colormap/grass', 256],
    ['colormap/foliage', 256],
  ] as const) {
    const file = path.join(assetsDir, 'minecraft/textures', name + '.png');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const png = new PNG({ width: size, height: size });
    png.data.fill(255);
    await fs.writeFile(file, PNG.sync.write(png));
  }
  const config = loadServerConfig({
    env: {
      DEPLOYMENT_PROFILE: 'sync',
      STATIC_API_TOKEN: 'browser-service-token',
      DATA_DIR: root,
      WORLDS_DIR: path.join(root, 'worlds'),
      ASSETS_DIRS: assetsDir,
    },
    cwd: root,
  });
  const services = await createServices(config);
  t.after(() => services.close());
  await services.worldStore.createWorld('browser');
  const app = createApp(config, services);
  const api = serve({
    fetch: (request) => {
      const url = new URL(request.url);
      url.pathname = url.pathname.replace(/^\/violet(?=\/)/, '');
      return app.fetch(new Request(url, request));
    },
    hostname: '127.0.0.1',
    port: 0,
  });
  t.after(() => close(api));
  const apiBase = `${await origin(api)}/violet/`;
  const webBase = (await fs.readFile(path.join(project, 'packages/web/dist/index.html'), 'utf8')).includes(
    '/map/assets/',
  )
    ? '/map/'
    : '/';
  const adminBase = (await fs.readFile(path.join(project, 'packages/admin/dist/index.html'), 'utf8')).includes(
    '/console/assets/',
  )
    ? '/console/'
    : '/';
  const web = await staticSite(root, 'web', webBase, apiBase),
    admin = await staticSite(root, 'admin', adminBase, apiBase);
  t.after(async () => {
    for (const site of [web, admin]) {
      site.child.kill('SIGTERM');
      await new Promise((resolve) => site.child.once('exit', resolve));
    }
  });
  const chrome =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
    (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ locale: 'en-US' });
  await context.addInitScript('globalThis.__name = (fn) => fn');
  const viewer = await context.newPage();
  const errors: string[] = [];
  viewer.on('pageerror', (error) => errors.push(error.message));
  await viewer.goto(web.url);
  await viewer.locator('canvas').first().waitFor({ timeout: 30_000 });
  const pixels = await viewer.evaluate(async (apiBase) => {
    const load = (url: string) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = url;
      });
    const response = await fetch(`${apiBase}api/assets/atlas`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['minecraft:block/stone'] }),
    });
    const manifest = await response.json();
    const images = await Promise.all([
      load(new URL(manifest.image, apiBase).href),
      load(`${apiBase}api/assets/texture/minecraft%3Ablock%2Fstone`),
      load(`${apiBase}api/assets/texture/minecraft%3Acolormap%2Fgrass`),
    ]);
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    const sizes: number[] = [];
    for (const image of images) {
      ctx.drawImage(image, 0, 0);
      sizes.push(ctx.getImageData(0, 0, 1, 1).data[3]);
    }
    const gpu = document.createElement('canvas').getContext('webgl2')!;
    const texture = gpu.createTexture();
    gpu.bindTexture(gpu.TEXTURE_2D, texture);
    gpu.texImage2D(gpu.TEXTURE_2D, 0, gpu.RGBA, gpu.RGBA, gpu.UNSIGNED_BYTE, images[0]);
    return {
      sizes,
      gpuError: gpu.getError(),
      exposedEtag: (await fetch(`${apiBase}api/assets/texture/minecraft%3Ablock%2Fstone`)).headers.get('etag'),
    };
  }, apiBase);
  assert.equal(pixels.gpuError, 0);
  assert.ok(pixels.exposedEtag);
  assert.ok(pixels.sizes.every((alpha) => alpha > 0));
  assert.deepEqual(errors, []);
  // Native Preact controls retain keyboard, input and camera behavior without
  // replacing the independently owned canvas during UI changes.
  const originalCanvas = await viewer.locator('canvas').first().elementHandle();
  assert.equal(
    await originalCanvas!.evaluate((canvas) => document.getElementById('root')!.contains(canvas)),
    false,
    'canvas must be outside the UI tree',
  );
  await viewer.getByRole('tab', { name: 'View', exact: true }).focus();
  await viewer.keyboard.press('ArrowRight');
  await viewer.getByRole('tab', { name: 'Settings', exact: true }).waitFor();
  assert.equal(await viewer.getByRole('tab', { name: 'Settings', exact: true }).getAttribute('aria-selected'), 'true');
  await viewer.getByRole('combobox', { name: 'Language', exact: true }).selectOption('zh-CN');
  await viewer.getByRole('tab', { name: '视图', exact: true }).click();
  await viewer.locator('#coord-x').fill('123');
  await viewer.locator('#coord-x').press('Control+a');
  assert.equal(await viewer.locator('#coord-x').evaluate((node: HTMLInputElement) => node.value), '123');
  await viewer.getByRole('button', { name: '前往', exact: true }).click();
  assert.equal(await originalCanvas!.evaluate((canvas) => canvas.isConnected), true);
  await viewer.getByRole('tab', { name: '设置', exact: true }).click();
  await viewer.getByRole('combobox', { name: '语言', exact: true }).selectOption('en');
  await viewer.getByRole('tab', { name: 'View', exact: true }).click();
  const consolePage = await context.newPage();
  await consolePage.goto(admin.url);
  await consolePage.locator('#admin-token').fill('browser-service-token');
  assert.equal(await consolePage.locator('#login-username').count(), 0);
  assert.equal(await consolePage.getByRole('tab', { name: 'Users', exact: true }).count(), 0);
  await consolePage.locator('#new-world').fill('created-by-browser');
  await consolePage.getByRole('button', { name: 'Create empty world' }).click();
  await consolePage.getByRole('cell', { name: 'created-by-browser', exact: true }).waitFor();
  const upload = await consolePage.evaluate(async (apiBase) => {
    const response = await fetch(`${apiBase}api/admin/storage/files/browser%2Fprobe`, {
      method: 'PUT',
      headers: { authorization: 'Bearer browser-service-token' },
      body: 'abcd',
    });
    const range = await fetch(`${apiBase}api/admin/storage/files/browser%2Fprobe`, {
      headers: { authorization: 'Bearer browser-service-token', range: 'bytes=1-2' },
    });
    return {
      write: response.status,
      status: range.status,
      range: range.headers.get('content-range'),
      body: await range.text(),
    };
  }, apiBase);
  assert.deepEqual(upload, { write: 200, status: 206, range: 'bytes 1-2/4', body: 'bc' });
  const secondConfig = loadServerConfig({
    env: {
      DEPLOYMENT_PROFILE: 'public',
      DATA_DIR: path.join(root, 'second'),
      WORLDS_DIR: path.join(root, 'second/worlds'),
    },
    cwd: root,
  });
  const secondServices = await createServices(secondConfig);
  t.after(() => secondServices.close());
  const seen: string[] = [];
  const secondApp = createApp(secondConfig, secondServices);
  const secondApi = serve({
    fetch: (request) => {
      const token = request.headers.get('authorization');
      if (token) seen.push(token);
      return secondApp.fetch(request);
    },
    hostname: '127.0.0.1',
    port: 0,
  });
  t.after(() => close(secondApi));
  const before = (await fs.readdir(path.join(admin.dist, 'assets'))).sort();
  await fs.writeFile(
    path.join(admin.dist, 'runtime-config.json'),
    JSON.stringify({ apiBaseUrl: await origin(secondApi) }),
  );
  await consolePage.reload();
  await consolePage.getByText('This server has not enabled management features.').waitFor();
  assert.deepEqual(seen, []);
  assert.deepEqual((await fs.readdir(path.join(admin.dist, 'assets'))).sort(), before);
  const keys = await consolePage.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('admin-token')));
  assert.equal(keys.length, 1);
  assert.ok(keys[0].includes(apiBase));
  await viewer.screenshot({ path: path.join(root, 'viewer.png') });
});
