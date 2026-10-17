import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { createApp } from '../../packages/server/src/app.js';
import { createServices } from '../../packages/server/src/services.js';
import { loadServerConfig } from '../../packages/server/src/configuration.js';
import type { OverlayHarness } from '../../packages/web/test/overlay-browser.js';
const execute = promisify(execFile),
  project = fileURLToPath(new URL('../../', import.meta.url));
function cubeGlb() {
  const vertices: number[] = [];
  const corners = [
    [-1, -1, -1],
    [1, -1, -1],
    [1, 1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
    [1, -1, 1],
    [1, 1, 1],
    [-1, 1, 1],
  ];
  for (const [a, b, c, d] of [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [3, 7, 6, 2],
    [0, 4, 7, 3],
    [1, 2, 6, 5],
  ])
    for (const i of [a, b, c, a, c, d]) vertices.push(...corners[i]);
  const binary = Buffer.from(new Float32Array(vertices).buffer);
  const raw = Buffer.from(
    JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [
        { pbrMetallicRoughness: { baseColorFactor: [1, 0.1, 0.1, 1], metallicFactor: 0, roughnessFactor: 0.8 } },
      ],
      buffers: [{ byteLength: binary.length }],
      bufferViews: [{ buffer: 0, byteLength: binary.length, target: 34962 }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: vertices.length / 3,
          type: 'VEC3',
          min: [-1, -1, -1],
          max: [1, 1, 1],
        },
      ],
    }),
  );
  const json = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 0x20);
  raw.copy(json);
  const out = Buffer.alloc(28 + json.length + binary.length);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(json.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  json.copy(out, 20);
  out.writeUInt32LE(binary.length, 20 + json.length);
  out.writeUInt32LE(0x004e4942, 24 + json.length);
  binary.copy(out, 28 + json.length);
  return out;
}
test(
  'overlay WebGL: projected terrain masks, walls, curves, API-prefixed media and resource lifetimes',
  { timeout: 180_000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-overlay-browser-'));
    const output = path.join(project, 'LOCAL_railway_deploy/overlay-acceptance');
    await fs.mkdir(output, { recursive: true });
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const config = loadServerConfig({
      env: {
        DEPLOYMENT_PROFILE: 'sync',
        STATIC_API_TOKEN: 'overlay-browser-token',
        ASSETS_DIRS: path.join(project, 'packages/server/data/assets'),
        CONTENT_READS_ENABLED: 'true',
        CONTENT_WRITES_ENABLED: 'true',
        DATA_DIR: root,
        WORLDS_DIR: path.join(root, 'worlds'),
        CACHE_PREWARM: 'false',
      },
      cwd: root,
    });
    const services = await createServices(config);
    t.after(() => services.close());
    await services.worldStore.createWorld('fixture');
    const app = createApp(config, services);
    const api = serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => {
        const url = new URL(request.url);
        url.pathname = url.pathname.replace(/^\/violet(?=\/)/, '');
        return app.fetch(new Request(url, request));
      },
    });
    await new Promise<void>((resolve) => (api.listening ? resolve() : api.once('listening', resolve)));
    t.after(
      () =>
        new Promise<void>((resolve) => {
          api.close(() => resolve());
          if ('closeAllConnections' in api) api.closeAllConnections();
        }),
    );
    const apiBase = `http://127.0.0.1:${(api.address() as { port: number }).port}/violet/`;
    const cli = async (args: string[]) =>
      JSON.parse(
        (
          await execute(
            process.execPath,
            [path.join(project, 'packages/cli/dist/cli.js'), '--cli-home', path.join(root, 'cli'), ...args],
            {
              cwd: project,
              env: { ...process.env, VIOLET_SERVER_URL: apiBase, VIOLET_SERVER_TOKEN: 'overlay-browser-token' },
              timeout: 30000,
            },
          )
        ).stdout,
      );
    const layer = async (features: unknown[]) => {
      const file = path.join(root, 'layer.json');
      await fs.writeFile(
        file,
        JSON.stringify({ schemaVersion: 1, layerId: 'fixture', revision: 1, name: 'fixture', features }),
      );
      await cli(['overlay', 'layer', 'validate', file]);
      return cli(['overlay', 'layer', 'import', file]);
    };
    const map = async (features: unknown[], dimensions = ['overworld']) => {
      const doc = await layer(features),
        registered = await cli(['map', 'register', '--world', 'fixture', '--name', 'fixture']);
      let revision = 1;
      for (const dimension of dimensions) {
        await cli([
          'overlay',
          'bind',
          '--map',
          registered.mapId,
          '--binding',
          dimension,
          '--layer',
          doc.layerId,
          '--dimension',
          dimension,
          '--if-match',
          String(revision++),
        ]);
      }
      return { mapId: registered.mapId, layer: doc };
    };
    const fill = (
      featureId: string,
      color: string,
      opacity: number,
      ring = [
        [-50, -12],
        [50, -12],
        [50, 12],
        [-50, 12],
      ],
    ) => ({
      featureId,
      kind: 'area',
      ring,
      minY: 2,
      maxY: 25,
      fill: { color, opacity },
      wall: { color, opacity, occlusion: 'terrain' },
    });
    const red = await map([fill('red', '#ff0000', 0.5)]),
      overlap = await map([fill('a-red', '#ff0000', 0.5), fill('b-blue', '#0000ff', 0.5)]),
      zero = await map([fill('zero', '#ff0000', 0)]),
      solid = await map([fill('solid', '#ff0000', 1)]);
    const wall = await map([
      fill('wall', '#ff0000', 0.5, [
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, 10],
      ]),
    ]);
    const always = await map([
      {
        ...fill('wall', '#ff0000', 0.5, [
          [-10, -10],
          [10, -10],
          [10, 10],
          [-10, 10],
        ]),
        wall: { color: '#ff0000', opacity: 0.5, occlusion: 'always' },
      },
    ]);
    const media: Record<string, { document: { assetId: string }; version: { versionId: string } }> = {};
    const pixels = Buffer.alloc(16 * 8 * 4);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 16; x++) {
        const i = (y * 16 + x) * 4;
        pixels[i] = y < 4 ? 255 : 0;
        pixels[i + 1] = y >= 4 ? 255 : 0;
        pixels[i + 2] = x >= 8 ? 255 : 0;
        pixels[i + 3] = x === 0 || x === 15 || y === 0 || y === 7 ? 0 : 255;
      }
    for (const format of ['png', 'jpeg', 'webp'] as const) {
      const file = path.join(root, `image.${format}`);
      await sharp(pixels, { raw: { width: 16, height: 8, channels: 4 } })
        .toFormat(format)
        .toFile(file);
      media[format] = await cli(['media', 'import', file]);
    }
    const svg = path.join(root, 'image.svg');
    await fs.writeFile(
      svg,
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 8"><path fill="#00ffff" d="M1 1h14v6H1z"/></svg>',
    );
    media.svg = await cli(['media', 'import', svg]);
    const glb = path.join(root, 'cube.glb');
    await fs.writeFile(glb, cubeGlb());
    media.glb = await cli(['media', 'import', glb]);
    const instance = (
      id: string,
      asset: (typeof media)[string],
      position: number[],
      placement = 'plane',
      extra = {},
    ) => ({
      featureId: id,
      kind: 'media',
      assetId: asset.document.assetId,
      versionId: asset.version.versionId,
      position,
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      views: ['top', 'player'],
      placement,
      ...(placement === 'model' ? {} : { size: [16, 8], anchor: [0, 0] }),
      ...extra,
    });
    const imageMap = await map([
      instance('png', media.png, [-40, 35, 0]),
      instance('jpeg', media.jpeg, [-16, 35, 0]),
      instance('webp', media.webp, [8, 35, 0]),
      instance('svg', media.svg, [32, 35, 0]),
    ]);
    const modelMap = await map(
      [
        instance('left', media.glb, [-12, 8, 0], 'model', { scale: [4, 4, 4] }),
        instance('right', media.glb, [12, 8, 0], 'model', { scale: [4, 4, 4], rotation: [0, Math.PI / 4, 0] }),
        instance('label', media.glb, [0, 20, 0], 'model', { scale: [4, 4, 4], lighting: 'label' }),
      ],
      ['overworld', 'the_nether', 'the_end'],
    );
    const upright = await map([
      instance('upright', media.svg, [-8, 2, 0], 'upright'),
      instance('billboard', media.png, [8, 2, 0], 'billboard', { views: ['player'] }),
    ]);
    const curve = (featureId: string, width = 8, widthUnit = 'pixels') => ({
      featureId,
      kind: 'curve',
      nodes: [
        { anchor: [-30, 35, 0], in: [0, 0, 0], out: [20, 0, 0] },
        { anchor: [30, 35, 0], in: [-20, 0, 0], out: [0, 0, 0] },
      ],
      closed: false,
      style: { color: '#ff0000', opacity: 1, width, widthUnit },
    });
    const pixelCurve = await map([curve('pixel')]),
      worldCurve = await map([curve('world', 2, 'blocks')]);
    const curved = await map([
      {
        ...curve('bezier'),
        nodes: [
          { anchor: [-30, 35, 0], in: [0, 0, 0], out: [0, 0, -40] },
          { anchor: [30, 35, 0], in: [0, 0, -40], out: [0, 0, 0] },
        ],
      },
    ]);
    const typical = await map([
      ...Array.from({ length: 20 }, (_, i) => ({
        ...curve(`c-${i}`),
        nodes: [
          { anchor: [-30, 35, i - 10], in: [0, 0, 0], out: [15, 0, -4] },
          { anchor: [30, 35, i - 10], in: [-15, 0, 4], out: [0, 0, 0] },
        ],
      })),
      ...Array.from({ length: 4 }, (_, i) => fill(`a-${i}`, '#ff0000', 0.2)),
      ...Array.from({ length: 8 }, (_, i) =>
        instance(`m-${i}`, i % 2 ? media.glb : media.png, [i * 5 - 20, 35, 5], i % 2 ? 'model' : 'plane'),
      ),
    ]);
    const pressure = await map([
      ...Array.from({ length: 500 }, (_, i) => curve(`c-${String(i).padStart(3, '0')}`, 1)),
      ...Array.from({ length: 20 }, (_, i) => fill(`b-${i}`, '#ff0000', 0.05)),
      ...Array.from({ length: 40 }, (_, i) =>
        instance(
          `a-${i}`,
          i % 2 ? media.glb : media.png,
          [(i % 16) * 4 - 32, 35, Math.floor(i / 16) * 4],
          i % 2 ? 'model' : 'plane',
        ),
      ),
    ]);
    const fixtureBuild = path.join(root, 'production-fixture');
    await execute(
      'pnpm',
      [
        '--filter',
        '@violet-map/web',
        'exec',
        'vite',
        'build',
        '--config',
        'vite.acceptance.config.ts',
        '--outDir',
        fixtureBuild,
      ],
      { cwd: project, timeout: 60000, maxBuffer: 4 * 1024 ** 2 },
    );
    await fs.copyFile(path.join(project, 'scripts/serve-static.mjs'), path.join(fixtureBuild, 'serve.mjs'));
    const fixture = spawn(process.execPath, [path.join(fixtureBuild, 'serve.mjs'), '0', apiBase], {
      env: { ...process.env, PORT: '0', STATIC_BASE_PATH: '/', API_BASE_URL: undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const fixtureUrl = await new Promise<string>((resolve, reject) => {
      fixture.stdout.on('data', (data) => {
        const match = String(data).match(/:(\d+)/);
        if (match) resolve(`http://127.0.0.1:${match[1]}`);
      });
      fixture.on('error', reject);
      fixture.on('exit', (code) => reject(new Error(`built fixture exited ${code}`)));
    });
    t.after(() => {
      fixture.kill('SIGTERM');
    });
    const browser = await chromium.launch({
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
        (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined),
      headless: true,
      args: ['--enable-unsafe-swiftshader'],
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.addInitScript('globalThis.__name = fn => fn');
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.goto(`${fixtureUrl}/test/overlay-browser.html?api=${encodeURIComponent(apiBase)}`);
    await page.waitForFunction(() => !!window.overlayHarness);
    const set = async (id: string, dimension = 'overworld') => {
      await page.evaluate(({ id, dimension }) => window.overlayHarness.set(id, dimension), { id, dimension });
      await page.waitForFunction((id) => {
        const s = window.overlayHarness.status();
        return s.mapId === id && !s.loading && s.features > 0;
      }, id);
    };
    for (const camera of ['topPerspective', 'topOrthographic'] as const) {
      await page.evaluate((mode) => window.overlayHarness.camera(mode), camera);
      await set(red.mapId);
      for (const kind of ['mixed', 'online', 'lod', 'topmap'] as const) {
        await page.evaluate((mode) => window.overlayHarness.surface(mode), kind);
        const colors = await page.evaluate(() =>
          [-40, 0, 40].map((x, i) => ({
            inside: window.overlayHarness.pixel([x, i * 12, 0]),
            outside: window.overlayHarness.pixel([x, i * 12, 24]),
          })),
        );
        for (const color of colors) {
          assert.ok(color.inside[0] > 145 && color.inside[1] < 40, JSON.stringify({ camera, kind, color }));
          assert.ok(Math.abs(color.outside[0] - 64) < 4 && Math.abs(color.outside[1] - 64) < 4);
        }
      }
      await set(overlap.mapId);
      const color = await page.evaluate(() => window.overlayHarness.pixel([0, 12, 0]));
      assert.ok(color[2] > color[0] && color[0] > color[1]);
      await set(zero.mapId);
      assert.ok(Math.abs((await page.evaluate(() => window.overlayHarness.pixel([0, 12, 0])))[0] - 64) < 4);
      await set(solid.mapId);
      const opaque = await page.evaluate(() => window.overlayHarness.pixel([0, 12, 0]));
      assert.ok(opaque[0] > 250 && opaque[1] < 3);
      await set(red.mapId);
      await page.screenshot({ path: path.join(output, `${camera}-terrain-mask.png`) });
    }
    await page.evaluate(() => {
      window.overlayHarness.surface('none');
      window.overlayHarness.camera('player', [0, 12, 45], [0, 12, 0]);
    });
    await set(wall.mapId);
    const front = await page.evaluate(() => window.overlayHarness.pixel([0, 12, 10]));
    assert.ok(front[0] > 60 && front[1] < 20);
    await page.evaluate(() => window.overlayHarness.camera('player', [0, 12, 0], [0, 12, 45]));
    const back = await page.evaluate(() => window.overlayHarness.pixel([0, 12, 10]));
    assert.ok(back[0] > 60 && back[1] < 20);
    await page.evaluate(() => {
      window.overlayHarness.camera('player', [0, 12, 45], [0, 12, 0]);
      window.overlayHarness.block(true);
    });
    assert.ok((await page.evaluate(() => window.overlayHarness.pixel([0, 12, 10])))[1] > 250);
    await page.evaluate(() => {
      window.overlayHarness.block(false);
      window.overlayHarness.water(true);
      window.overlayHarness.camera('player', [0, 18, 45], [0, 8, 0]);
    });
    await set(overlap.mapId);
    const waterWall = await page.evaluate(() => window.overlayHarness.pixel([0, 8, 10]));
    assert.ok(waterWall[0] > 20 && waterWall[2] > 20, JSON.stringify(waterWall));
    await page.screenshot({ path: path.join(output, 'water-intersecting-walls.png') });
    await page.evaluate(() => {
      window.overlayHarness.water(false);
      window.overlayHarness.block(true);
      window.overlayHarness.camera('player', [0, 12, 45], [0, 12, 0]);
    });
    await set(always.mapId);
    assert.ok((await page.evaluate(() => window.overlayHarness.pixel([0, 12, 10])))[0] > 60);
    await page.screenshot({ path: path.join(output, 'player-wall.png') });
    await page.evaluate(() => {
      window.overlayHarness.block(false);
      window.overlayHarness.camera('topOrthographic');
    });
    await set(imageMap.mapId);
    await page.waitForFunction(
      () =>
        window.overlayHarness.status().pending === 0 &&
        window.overlayHarness.status().versions === 4 &&
        window.overlayHarness.status().active === 4,
    );
    const imagePixels = await page.evaluate(() =>
      [-40, -16, 8, 32].map((x) => window.overlayHarness.pixel([x + 8, 35, -4])),
    );
    for (const p of imagePixels) assert.ok(Math.max(...p.slice(0, 3)) > 100, JSON.stringify(imagePixels));
    const topPixel = await page.evaluate(() => window.overlayHarness.pixel([-40 + 4, 35, -6]));
    const bottomPixel = await page.evaluate(() => window.overlayHarness.pixel([-40 + 4, 35, -2]));
    assert.ok(topPixel[0] > 200 && topPixel[1] < 30);
    assert.ok(bottomPixel[1] > 200 && bottomPixel[0] < 30);
    const transparentEdge = await page.evaluate(() => window.overlayHarness.pixel([-39.75, 35, -0.25]));
    assert.ok(
      transparentEdge.slice(0, 3).every((v) => Math.abs(v - 16) < 4),
      JSON.stringify(transparentEdge),
    );
    const imageBounds = await page.evaluate(() => window.overlayHarness.objects());
    const pngBounds = imageBounds.find((o) => o.position[0] === -40)!.bounds;
    assert.deepEqual(pngBounds.min, [-40, 35, -8]);
    assert.deepEqual(pngBounds.max, [-24, 35, 0]);
    await page.screenshot({ path: path.join(output, 'top-images.png') });
    assert.ok(
      !requests.some((url) => /GLTFLoader|overlay-gltf/.test(url)),
      'GLB loader must remain lazy before the first visible model',
    );
    const changedFile = path.join(root, 'changed.png');
    await sharp({ create: { width: 16, height: 8, channels: 4, background: '#ffff00' } })
      .png()
      .toFile(changedFile);
    const newVersion = await cli([
      'media',
      'import',
      changedFile,
      '--asset',
      media.png.document.assetId,
      '--if-match',
      '1',
    ]);
    await page.evaluate(() => window.overlayHarness.refresh());
    assert.ok(
      (await page.evaluate(() => window.overlayHarness.pixel([-36, 35, -6])))[1] < 30,
      'publishing a version must not upgrade a pinned instance',
    );
    const nextFeatures = imageMap.layer.features.map((feature: Record<string, unknown>) =>
      feature.featureId === 'png' ? { ...feature, versionId: newVersion.version.versionId } : feature,
    );
    await fs.writeFile(path.join(root, 'upgrade.json'), JSON.stringify({ ...imageMap.layer, features: nextFeatures }));
    await cli([
      'overlay',
      'layer',
      'replace',
      imageMap.layer.layerId,
      path.join(root, 'upgrade.json'),
      '--if-match',
      '1',
    ]);
    await page.evaluate(() => window.overlayHarness.refresh());
    await page.waitForFunction(
      () => window.overlayHarness.status().pending === 0 && window.overlayHarness.status().versions === 4,
    );
    const upgraded = await page.evaluate(() => window.overlayHarness.pixel([-36, 35, -6]));
    assert.ok(upgraded[0] > 240 && upgraded[1] > 240, 'explicit instance upgrade selects new version');
    await set(modelMap.mapId);
    await page.evaluate(() => window.overlayHarness.camera('player', [0, 16, 55], [0, 12, 0]));
    await page.waitForFunction(
      () =>
        window.overlayHarness.status().pending === 0 &&
        window.overlayHarness.status().versions === 1 &&
        window.overlayHarness.status().active === 3,
    );
    const modelBounds = await page.evaluate(() => window.overlayHarness.objects());
    const leftBounds = modelBounds.find((o) => o.position[0] === -12)!.bounds,
      rightBounds = modelBounds.find((o) => o.position[0] === 12)!.bounds;
    assert.deepEqual(leftBounds, { min: [-16, 4, -4], max: [-8, 12, 4] });
    assert.ok(Math.abs(rightBounds.max[0] - (12 + 4 * Math.SQRT2)) < 1e-5);
    for (const dimension of ['overworld', 'the_nether', 'the_end'])
      for (const day of [0, 1]) {
        await set(modelMap.mapId, dimension);
        await page.evaluate(({ sky, day }) => window.overlayHarness.lighting(sky as 'normal' | 'nether' | 'end', day), {
          sky: dimension === 'overworld' ? 'normal' : dimension === 'the_nether' ? 'nether' : 'end',
          day,
        });
        await page.waitForFunction(
          () => window.overlayHarness.status().pending === 0 && window.overlayHarness.status().versions === 1,
        );
        const p = await page.evaluate(() => window.overlayHarness.pixel([-12, 8, 4]));
        assert.ok(p[0] > 35, JSON.stringify({ dimension, day, p }));
      }
    await page.screenshot({ path: path.join(output, 'player-models.png') });
    const beforeDelete = requests.filter((url) => url.includes('/media/')).length;
    await fs.writeFile(
      path.join(root, 'remove.json'),
      JSON.stringify({
        ...modelMap.layer,
        features: modelMap.layer.features.filter((feature: { featureId: string }) => feature.featureId !== 'left'),
      }),
    );
    await cli([
      'overlay',
      'layer',
      'replace',
      modelMap.layer.layerId,
      path.join(root, 'remove.json'),
      '--if-match',
      '1',
    ]);
    await page.evaluate(() => window.overlayHarness.refresh());
    await page.waitForFunction(() => window.overlayHarness.status().active === 2);
    assert.equal(await page.evaluate(() => window.overlayHarness.status().versions), 1);
    assert.equal(
      requests.filter((url) => url.includes('/media/')).length,
      beforeDelete,
      'remaining model owners retain shared resources without a refetch',
    );

    await set(upright.mapId);
    await page.evaluate(() => window.overlayHarness.camera('player', [25, 15, 40], [0, 8, 0]));
    await page.waitForFunction(
      () => window.overlayHarness.status().versions === 2 && window.overlayHarness.status().pending === 0,
    );
    await page.screenshot({ path: path.join(output, 'upright-billboard.png') });
    await page.evaluate(() => window.overlayHarness.camera('topOrthographic'));
    await page.waitForFunction(() => window.overlayHarness.status().versions === 1);
    await page.evaluate(() => {
      window.overlayHarness.surface('none');
      window.overlayHarness.camera('topOrthographic');
    });
    const widths: Record<string, number> = {};
    for (const mode of ['topOrthographic', 'topPerspective'] as const) {
      await page.evaluate((mode) => window.overlayHarness.camera(mode), mode);
      await set(pixelCurve.mapId);
      const width = await page.evaluate((mode) => {
        const unit = mode === 'topOrthographic' ? 0.2 : (2 * 115 * Math.tan((25 * Math.PI) / 180)) / 600;
        return Array.from({ length: 41 }, (_, i) => window.overlayHarness.pixel([0, 35, (i - 20) * unit])).filter(
          (p) => p[0] > 180 && p[1] < 30,
        ).length;
      }, mode);
      widths[mode] = width;
      assert.ok(width >= 7 && width <= 10, JSON.stringify(widths));
    }
    await set(worldCurve.mapId);
    for (const height of [150, 300]) {
      await page.evaluate((height) => window.overlayHarness.camera('topPerspective', [0, height, 0]), height);
      widths[String(height)] = await page.evaluate((height) => {
        const unit = (2 * (height - 35) * Math.tan((25 * Math.PI) / 180)) / 600;
        return Array.from({ length: 41 }, (_, i) => window.overlayHarness.pixel([0, 35, (i - 20) * unit])).filter(
          (p) => p[0] > 180 && p[1] < 30,
        ).length;
      }, height);
    }
    assert.ok(widths['150'] > widths['300'] * 1.6, JSON.stringify(widths));
    await page.evaluate(() => window.overlayHarness.camera('topOrthographic'));
    await set(curved.mapId);
    const center = await page.evaluate(() => window.overlayHarness.pixel([0, 35, -30]));
    assert.ok(center[0] > 180);
    await page.screenshot({ path: path.join(output, 'bezier-curve.png') });
    const benchmarks = [];
    const userAgent = await page.evaluate(() => navigator.userAgent),
      hardware = {
        platform: process.platform,
        arch: process.arch,
        cpus: os.cpus()[0]?.model,
        viewport: [800, 600],
        dpr: 1,
        userAgent,
      };
    await page.evaluate(() => window.overlayHarness.surface('mixed'));
    for (const [name, id] of [
      ['baseline', null],
      ['typical', typical.mapId],
      ['pressure', pressure.mapId],
    ] as const) {
      const start = requests.length;
      if (id) await set(id);
      else await page.evaluate(() => window.overlayHarness.set(null));
      await page.waitForFunction(() => window.overlayHarness.status().pending === 0);
      const loadedRequests = requests.length - start;
      const measurement = await page.evaluate(() => window.overlayHarness.benchmark());
      benchmarks.push({
        name,
        loadRequests: loadedRequests,
        pathRequests: requests.length - start - loadedRequests,
        ...measurement,
      });
      const limits = await page.evaluate(() => window.overlayHarness.limits());
      assert.ok(measurement.peakActive <= limits.activeFeatures);
      assert.ok(measurement.peakMedia <= limits.mediaBytes);
      assert.ok(measurement.peakMask <= limits.maskPixels ** 2 * 4);
      assert.ok(measurement.peakCurvePoints <= limits.curvePointsTotal);
      assert.equal(measurement.checkpoints[2].status.active, 0);
      assert.equal(measurement.checkpoints[2].status.resourceBytes, 0);
      assert.equal(measurement.checkpoints[2].status.maskBytes, 0);
    }
    assert.ok(benchmarks[2].gpu.suppressed > 0);
    if (process.env.VIOLET_REFERENCE_PERF === '1') {
      for (const [index, budget] of [2, 6, 12].entries()) {
        assert.ok(
          benchmarks[index].cpuMs.p95 <= budget,
          `${benchmarks[index].name} render CPU p95 exceeds reference ${budget} ms`,
        );
        assert.ok(
          benchmarks[index].frameMs.p95 <= 34,
          `${benchmarks[index].name} reference frame interval p95 exceeds 34 ms`,
        );
      }
    }
    await page.screenshot({ path: path.join(output, 'pressure.png') });
    let unblock!: () => void,
      blocked = 0;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const delayed = `**/api/maps/${imageMap.mapId}/media/**`;
    let canceled = 0;
    page.on('requestfailed', (request) => {
      if (request.url().includes(`/maps/${imageMap.mapId}/media/`)) canceled++;
    });
    await page.route(delayed, async (route) => {
      blocked++;
      await gate;
      try {
        await route.continue();
      } catch {
        /* Expected after request cancellation. */
      }
    });
    await set(imageMap.mapId);
    for (let i = 0; i < 100 && blocked === 0; i++) await page.waitForTimeout(10);
    assert.ok(blocked > 0);
    await page.evaluate(() => window.overlayHarness.set(null));
    unblock();
    await page.unroute(delayed);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.overlayHarness.status().resourceBytes), 0);
    assert.ok(canceled > 0, 'context switch cancels actual pending media requests');
    const samples = [];
    for (let i = 0; i < 5; i++) {
      await set(imageMap.mapId);
      await page.waitForFunction(
        () => window.overlayHarness.status().pending === 0 && window.overlayHarness.status().versions === 4,
      );
      await page.evaluate(() => window.overlayHarness.set(null));
      await page.waitForTimeout(100);
      await page.requestGC();
      samples.push(
        await page.evaluate(() => ({
          memory: window.overlayHarness.memory(),
          status: window.overlayHarness.status(),
          heapBytes: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0,
        })),
      );
    }
    for (const s of samples) {
      assert.equal(s.status.resourceBytes, 0);
      assert.equal(s.status.maskBytes, 0);
      assert.equal(s.status.versions, 0);
    }
    assert.equal(samples.at(-1)!.memory.textures, samples[0].memory.textures);
    assert.equal(samples.at(-1)!.memory.geometries, samples[0].memory.geometries);
    assert.ok(
      samples.at(-1)!.heapBytes <= samples[0].heapBytes + 2 * 1024 ** 2,
      'retained heap stays within the measured 2 MiB churn tolerance',
    );
    assert.equal(benchmarks[0].loadRequests + benchmarks[0].pathRequests, 0);
    const disabledRequests = requests.length;
    await page.evaluate(() => window.overlayHarness.set(null));
    await page.waitForTimeout(200);
    assert.equal(requests.length, disabledRequests);
    const builtRoot = path.join(root, 'built-web');
    await execute('pnpm', ['--filter', '@violet-map/web', 'exec', 'vite', 'build', '--outDir', builtRoot], {
      cwd: project,
      env: { ...process.env, VITE_BASE_PATH: '/map/' },
      timeout: 60000,
      maxBuffer: 4 * 1024 ** 2,
    });
    await fs.copyFile(path.join(project, 'scripts/serve-static.mjs'), path.join(builtRoot, 'serve.mjs'));
    const built = spawn(process.execPath, [path.join(builtRoot, 'serve.mjs'), '0', apiBase], {
      env: { ...process.env, PORT: '0', STATIC_BASE_PATH: '/map/', API_BASE_URL: undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => {
      built.kill('SIGTERM');
    });
    const builtUrl = await new Promise<string>((resolve, reject) => {
      built.stdout.on('data', (data) => {
        const match = String(data).match(/:(\d+)/);
        if (match) resolve(`http://127.0.0.1:${match[1]}/map`);
      });
      built.on('error', reject);
      built.on('exit', (code) => reject(new Error(`built viewer exited ${code}`)));
    });
    const builtHtml = await fs.readFile(path.join(builtRoot, 'index.html'), 'utf8');
    assert.ok(!builtHtml.includes('overlay-gltf'), 'optional GLB chunk must not be preloaded');
    assert.ok((await fs.readdir(path.join(builtRoot, 'assets'))).some((name) => name.startsWith('overlay-gltf')));
    const ui = await browser.newPage();
    await ui.addInitScript('globalThis.__name = fn => fn');
    const uiErrors: string[] = [];
    const uiMedia = new Set<string>();
    ui.on('response', (r) => {
      if (r.ok() && r.url().includes(`/maps/${imageMap.mapId}/media/`)) uiMedia.add(r.url());
    });
    ui.on('console', (message) => {
      if (/THREE.WebGLProgram|GL_INVALID|VALIDATE_STATUS/.test(message.text())) uiErrors.push(message.text());
    });
    ui.on('pageerror', (e) => uiErrors.push(e.message));
    await ui.route('**/runtime-config.json', (route) => route.fulfill({ json: { apiBaseUrl: apiBase } }));
    await ui.goto(
      `${builtUrl}/?world=fixture&overlayMapId=${imageMap.mapId}&viewMode=topOrthographic&viewDistance=2&lodDistance=0`,
    );
    await ui.locator('[data-testid="overlay-status"]').filter({ hasText: /4/ }).waitFor({ timeout: 30000 });
    await ui.locator('#overlay-toggle').click();
    await ui.waitForFunction(() => !document.querySelector('[data-testid="overlay-status"]'));
    await ui.locator('#overlay-toggle').click();
    await ui.locator('[data-testid="overlay-status"]').filter({ hasText: /4/ }).waitFor();
    for (let i = 0; i < 100 && uiMedia.size < 4; i++) await ui.waitForTimeout(50);
    assert.equal(uiMedia.size, 4, 'built viewer downloads all visible images');
    await ui.waitForTimeout(200);
    const viewerShot = await ui.screenshot({ path: path.join(output, 'viewer-integration.png') });
    const centerPixels = await sharp(viewerShot)
      .extract({ left: 500, top: 300, width: 300, height: 160 })
      .removeAlpha()
      .raw()
      .toBuffer();
    let yellow = 0;
    for (let i = 0; i < centerPixels.length; i += 3)
      if (centerPixels[i] > 200 && centerPixels[i + 1] > 200 && centerPixels[i + 2] < 100) yellow++;
    assert.ok(yellow > 5, 'built viewer renders the upgraded yellow image');
    let modelSource = false,
      loaderSource = false;
    ui.on('response', (response) => {
      if (response.ok() && response.url().includes(`/maps/${modelMap.mapId}/media/`)) modelSource = true;
      if (response.ok() && response.url().includes('overlay-gltf')) loaderSource = true;
    });
    await ui.goto(
      `${builtUrl}/?world=fixture&overlayMapId=${modelMap.mapId}&viewMode=topOrthographic&viewDistance=2&lodDistance=0`,
    );
    await ui.getByTestId('overlay-status').filter({ hasText: /2/ }).waitFor({ timeout: 30000 });
    for (let i = 0; i < 100 && (!modelSource || !loaderSource); i++) await ui.waitForTimeout(50);
    assert.ok(modelSource && loaderSource, 'built /map viewer loads a visible GLB and its deferred bundle');
    await ui.waitForTimeout(150);
    const modelShot = await ui.screenshot({ path: path.join(output, 'viewer-model-integration.png') });
    const modelPixels = await sharp(modelShot)
      .extract({ left: 500, top: 300, width: 300, height: 160 })
      .removeAlpha()
      .raw()
      .toBuffer();
    let redPixelsCount = 0;
    for (let i = 0; i < modelPixels.length; i += 3)
      if (modelPixels[i] > 100 && modelPixels[i + 1] < 100 && modelPixels[i + 2] < 100) redPixelsCount++;
    assert.ok(redPixelsCount > 5, 'built /map viewer renders GLB');
    assert.deepEqual(uiErrors, []);
    await ui.close();
    const legacy = await browser.newPage();
    await legacy.addInitScript('globalThis.__name = fn => fn');
    const legacyRequests: string[] = [];
    legacy.on('request', (r) => legacyRequests.push(r.url()));
    await legacy.route('**/runtime-config.json', (route) => route.fulfill({ json: { apiBaseUrl: apiBase } }));
    const legacyCapabilities = await (await fetch(new URL('api/capabilities', apiBase))).json();
    delete legacyCapabilities.contentReads;
    delete legacyCapabilities.contentWrites;
    await legacy.route('**/api/capabilities', (route) => route.fulfill({ json: legacyCapabilities }));
    await legacy.goto(`${builtUrl}/?world=fixture&viewDistance=2&lodDistance=0`);
    await legacy.locator('canvas').first().waitFor({ timeout: 30000 });
    await legacy.waitForTimeout(400);
    assert.equal(await legacy.locator('#overlay-toggle').count(), 0);
    assert.ok(
      !legacyRequests.some((url) => /\/api\/maps\/[^/]+\/(overlays|media\/)|GLTFLoader|overlay-gltf/.test(url)),
    );
    await legacy.close();
    assert.deepEqual(errors, []);
    assert.ok(requests.some((url) => url.includes('/violet/api/maps/') && url.includes('/media/')));
    await fs.writeFile(
      path.join(output, 'browser-results.json'),
      JSON.stringify(
        {
          hardware,
          buildMode: 'production',
          cameraPath: '180 frames: orthographic sweep, perspective sweep, offscreen, return',
          canceledRequests: canceled,
          widths,
          benchmarks,
          gpuResourceSamples: samples,
          apiPrefix: apiBase,
          consoleErrors: errors,
          passed: true,
        },
        null,
        2,
      ),
    );
  },
);
