import { chromiumExecutablePath } from '../helpers/browser.mjs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import { createApp } from '../../packages/server/src/app.js';
import { createServices } from '../../packages/server/src/services.js';
import { loadServerConfig } from '../../packages/server/src/configuration.js';
import { project, closeServer, serverOrigin, startStaticSite } from './helpers/frontend.js';

test('three origins: static prefixes, CORS pixels/WebGL, uploads, capabilities and token isolation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-frontend-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { PNG } = createRequire(new URL('../../packages/resources/package.json', import.meta.url))('pngjs');
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
  await services.worldStore!.createWorld('browser');
  await services.worldStore!.createWorld('browser-second');
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
  t.after(() => closeServer(api));
  const apiBase = `${await serverOrigin(api)}/violet/`;
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
  const web = await startStaticSite(root, 'web', webBase, apiBase),
    admin = await startStaticSite(root, 'admin', adminBase, apiBase);
  t.after(async () => {
    for (const site of [web, admin]) {
      await site.close();
    }
  });
  const chrome = chromiumExecutablePath();
  const browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ locale: 'en-US' });
  await context.addInitScript('globalThis.__name = (fn) => fn');
  const viewer = await context.newPage();
  await viewer.addInitScript(() => {
    const probe = { keys: [] as string[], unlocks: 0 };
    Object.assign(window, { keyboardLockProbe: probe });
    Object.defineProperty(navigator, 'keyboard', {
      configurable: true,
      value: {
        async lock(keys: string[]) {
          probe.keys = keys;
        },
        unlock() {
          probe.unlocks++;
        },
      },
    });
  });
  const errors: string[] = [];
  viewer.on('pageerror', (error) => errors.push(error.message));
  let releaseBundle!: () => void;
  const bundleGate = new Promise<void>((resolve) => {
    releaseBundle = resolve;
  });
  const bundleStarted = viewer.waitForRequest(
    (request) =>
      request.url().endsWith('/api/resources/resolve') &&
      request.postDataJSON()?.selectors?.some((selector: { kind: string }) => selector.kind === 'asset-bundle'),
  );
  await viewer.route('**/api/resources/resolve', async (route) => {
    if (
      route
        .request()
        .postDataJSON()
        ?.selectors?.some((selector: { kind: string }) => selector.kind === 'asset-bundle')
    )
      await bundleGate;
    await route.continue();
  });
  await viewer.goto(web.url + '?world=browser');
  await bundleStarted;
  await viewer.locator('#world-select').selectOption('browser-second', { force: true });
  const selectedCoverage = viewer.waitForResponse(
    (response) =>
      response.url().includes('/worlds/browser-second/') &&
      new URL(response.url()).pathname.endsWith('/chunk-coverage'),
  );
  releaseBundle();
  await viewer.locator('canvas').first().waitFor({ timeout: 30_000 });
  await selectedCoverage;
  assert.equal(await viewer.locator('#world-select').inputValue(), 'browser-second');
  assert.equal(await viewer.getByRole('alert').count(), 0, 'a bootstrap switch revived an obsolete world failure');
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
    if (!response.ok) throw new Error(`atlas HTTP ${response.status}: ${JSON.stringify(manifest)}`);
    const images = await Promise.all([
      load(new URL(manifest.image.url.replace(/^\/api\//, 'api/'), apiBase).href),
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
  await viewer.evaluate(() => {
    history.replaceState = () => {
      throw new DOMException('history is restricted', 'SecurityError');
    };
  });
  await viewer.locator('#coord-x').fill('123');
  await viewer.locator('#coord-x').press('Control+a');
  assert.equal(await viewer.locator('#coord-x').evaluate((node: HTMLInputElement) => node.value), '123');
  await viewer.locator('#coord-x').press('4');
  assert.equal(
    await viewer.locator('#coord-x').inputValue(),
    '4',
    'native select-all remains available while editing coordinates',
  );
  await viewer.locator('#coord-x').fill('123');
  for (const mode of ['perspective', 'topPerspective', 'topOrthographic']) {
    await viewer.locator('#view-mode').selectOption(mode);
    await viewer.locator('#coord-x').focus();
    await viewer
      .locator('canvas')
      .first()
      .click({ position: { x: 700, y: 500 } });
    assert.equal(
      await viewer.evaluate(() => document.activeElement === document.querySelector('canvas')),
      true,
      `${mode}: clicking terrain must release form focus`,
    );
    const consumed = await viewer.evaluate(() => {
      const canvas = document.querySelector('canvas')!;
      const stop = (event: Event) => event.stopPropagation();
      canvas.addEventListener('keydown', stop);
      try {
        return ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR'].flatMap((code) =>
          [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { ctrlKey: true, shiftKey: true }].map(
            (modifiers) => {
              const event = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...modifiers });
              canvas.dispatchEvent(event);
              canvas.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
              return event.defaultPrevented;
            },
          ),
        );
      } finally {
        canvas.removeEventListener('keydown', stop);
      }
    });
    assert.ok(consumed.every(Boolean), `${mode}: navigation must be cancelled before target/bubble handlers`);
    await viewer.evaluate(() => document.exitPointerLock());
  }
  await viewer.locator('#view-mode').selectOption('perspective');
  // Exercise real fullscreen and the UI lifecycle with a deterministic keyboard
  // adapter; reserved accelerators are not portable Playwright input events.
  await viewer.getByRole('button', { name: '全屏并锁定导航快捷键', exact: true }).click();
  await viewer.getByRole('button', { name: '释放键盘锁', exact: true }).waitFor();
  assert.equal(await viewer.evaluate(() => document.fullscreenElement === document.documentElement), true);
  const lockedKeys = await viewer.evaluate(
    () => (window as unknown as { keyboardLockProbe: { keys: string[] } }).keyboardLockProbe.keys,
  );
  assert.ok(lockedKeys.includes('KeyW') && lockedKeys.includes('KeyR'));
  assert.ok(!lockedKeys.includes('Escape') && !lockedKeys.includes('Tab'));
  await viewer.evaluate(() => document.exitFullscreen());
  await viewer.getByRole('button', { name: '全屏并锁定导航快捷键', exact: true }).waitFor();
  assert.ok(
    await viewer.evaluate(
      () => (window as unknown as { keyboardLockProbe: { unlocks: number } }).keyboardLockProbe.unlocks > 0,
    ),
  );
  await viewer.getByRole('button', { name: '前往', exact: true }).click();
  await viewer.waitForFunction(() => JSON.parse(localStorage.getItem('violet-map:view') ?? '{}').x === 123);
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
  t.after(() => closeServer(secondApi));
  const before = (await fs.readdir(path.join(admin.dist, 'assets'))).sort();
  await fs.writeFile(
    path.join(admin.dist, 'runtime-config.json'),
    JSON.stringify({ apiBaseUrl: await serverOrigin(secondApi) }),
  );
  await consolePage.reload();
  await consolePage.getByText('This server has not enabled management features.').waitFor();
  assert.deepEqual(seen, []);
  assert.deepEqual((await fs.readdir(path.join(admin.dist, 'assets'))).sort(), before);
  const keys = await consolePage.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('admin-token')));
  assert.equal(keys.length, 1);
  assert.ok(keys[0].includes(apiBase));
  await viewer.screenshot({ path: path.join(root, 'viewer.png') });
  assert.deepEqual(errors, [], 'camera persistence must tolerate restricted history without interrupting the viewer');
});
