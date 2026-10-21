import { execute, stopProcess } from '../helpers/process.mjs';
import { chromiumExecutablePath } from '../helpers/browser.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { waitForProcessOutput } from './helpers/process-startup';
import { OIT_MAX_PIXELS, OIT_BYTES_PER_PIXEL } from '../../packages/web/src/render/oitShaders';
import type {} from '../../packages/web/test/transparency-browser';

const project = fileURLToPath(new URL('../../', import.meta.url));

function near(actual: number[], expected: number[], tolerance = 2) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) =>
    assert.ok(Math.abs(value - expected[i]) <= tolerance, `channel ${i}: ${actual} vs ${expected}`),
  );
}

test(
  'depth-binned WebGL: synthetic voxel world, order invariance, alpha, materials and ownership',
  { timeout: 180_000 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-transparency-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const output = path.join(project, 'LOCAL_render_acceptance/transparency');
    await fs.mkdir(output, { recursive: true });
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
        root,
      ],
      { cwd: project, timeout: 60000, maxBuffer: 4 * 1024 ** 2 },
    );
    await fs.copyFile(path.join(project, 'scripts/serve-static.mjs'), path.join(root, 'serve.mjs'));
    const server = spawn(process.execPath, [path.join(root, 'serve.mjs'), '0', 'http://127.0.0.1:1/'], {
      env: { ...process.env, PORT: '0', STATIC_BASE_PATH: '/', API_BASE_URL: undefined },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    t.after(() => stopProcess(server));
    const marker = await waitForProcessOutput(server, /Static Violet Map on :(\d+)(?=\/|\s)/, 'transparency fixture');
    const url = `http://127.0.0.1:${marker[1]}/test/transparency-browser.html`;
    const browser = await chromium.launch({
      executablePath: chromiumExecutablePath(),
      headless: true,
      args: ['--enable-unsafe-swiftshader'],
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 960, height: 720 }, deviceScaleFactor: 1 });
    await page.addInitScript('globalThis.__name = fn => fn');
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(url);
    await page.waitForFunction(() => !!window.transparencyHarness);
    const results = [];
    for (const projection of ['orthographic', 'perspective']) {
      for (const kind of ['single', 'layers', 'crossing', 'occluded', 'foreground', 'standard'] as const) {
        const result = await page.evaluate(
          ({ kind, projection }) => window.transparencyHarness.setup(kind, projection),
          { kind, projection },
        );
        if (kind === 'single') near(result.center, [128, 0, 0, 255]);
        if (kind === 'layers') near(result.center, [128, 0, 64, 255]);
        if (kind === 'occluded') near(result.center, [0, 255, 0, 255]);
        if (kind === 'foreground') near(result.center, [64, 128, 32, 255]);
        if (kind === 'standard') assert.ok(result.center[0] > 110 && result.center[0] < 140);
        if (kind === 'crossing') {
          assert.ok(result.left[0] > result.left[2] + 40);
          assert.ok(result.right[2] > result.right[0] + 40);
          await page.screenshot({ path: path.join(output, `crossing-${projection}.png`) });
        }
        const order = await page.evaluate(() => window.transparencyHarness.reorder());
        assert.ok(order.maxDifference <= 1, `${kind}/${projection}: submission order affected the image`);
        if (result.status.transparentDraws > 1) assert.notDeepEqual(order.beforeOrder, order.afterOrder);
        results.push({ kind, projection, ...result, order });
      }
    }
    const edges = await page.evaluate(() => window.transparencyHarness.edges());
    near(edges.opaque, [0, 255, 0, 255]);
    near(edges.hidden, [0, 0, 128, 255]);
    near(edges.dynamic, [128, 0, 64, 255]);
    const coveredRange = await page.evaluate(() => window.transparencyHarness.coveredRange());
    near(coveredRange, [128, 128, 0, 255]);
    const textured = await page.evaluate(() => window.transparencyHarness.textured());
    near(textured.alpha.left, [0, 0, 0, 255]);
    near(textured.alpha.right, [128, 0, 0, 255]);
    near(textured.cutout.left, [0, 0, 128, 255]);
    near(textured.cutout.right, [0, 255, 0, 255]);
    const glb = await page.evaluate(() => window.transparencyHarness.glb());
    assert.equal(glb.blended, 1);
    assert.ok(glb.center[0] > 110 && glb.center[0] < 140);
    assert.equal(glb.status.transparentDraws, 1);
    const reference = await page.evaluate(() => window.transparencyHarness.reference());
    near(reference.result, reference.original, 0);
    assert.match(reference.failure, /expected material failure/);
    assert.equal(reference.restored, true);
    const worlds = [];
    for (const projection of ['perspective', 'orthographic']) {
      const world = await page.evaluate((projection) => window.transparencyHarness.world(projection), projection);
      assert.equal(world.chunks, 4);
      assert.ok(world.blocks > 1800 && world.triangles > 2000);
      assert.ok(world.status.transparentDraws >= 6);
      const order = await page.evaluate(() => window.transparencyHarness.reorder());
      assert.ok(order.maxDifference <= 2 && order.changed < 100, `voxel ${projection}: ${JSON.stringify(order)}`);
      assert.notDeepEqual(order.beforeOrder, order.afterOrder);
      await page.screenshot({ path: path.join(output, `world-${projection}.png`) });
      const benchmark = await page.evaluate(() => window.transparencyHarness.benchmark());
      worlds.push({ projection, ...world, order, benchmark });
    }
    const large = await page.evaluate(() => window.transparencyHarness.resize(3840, 2160));
    assert.ok(large.width * large.height <= OIT_MAX_PIXELS);
    assert.equal(large.bufferBytes, large.width * large.height * OIT_BYTES_PER_PIXEL);
    const small = await page.evaluate(() => window.transparencyHarness.resize(320, 240));
    assert.deepEqual([small.width, small.height], [320, 240]);
    const lifetimes = [];
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.transparencyHarness.world());
      await page.evaluate(() => window.transparencyHarness.setup('single'));
      lifetimes.push(await page.evaluate(() => window.transparencyHarness.memory()));
    }
    assert.deepEqual(lifetimes.at(-1), lifetimes[0]);
    assert.equal(lifetimes[0].status.materials, 1);
    const pointSize = await page.evaluate(() => window.transparencyHarness.pointSize());
    for (const result of pointSize) {
      assert.ok(result.reference >= 60 && result.reference <= 70, JSON.stringify(result));
      assert.ok(Math.abs(result.reference - result.actual) <= 2, JSON.stringify(result));
    }
    const disposed = await page.evaluate(() => window.transparencyHarness.dispose());
    assert.equal(disposed.geometries, 0);
    // MeshStandardMaterial's renderer-owned BRDF LUT survives until renderer.dispose().
    assert.ok(disposed.textures <= 1);
    assert.deepEqual(errors, []);
    const unsupported = await browser.newPage();
    await unsupported.addInitScript(() => {
      const prototype = WebGL2RenderingContext.prototype as unknown as { getExtension(name: string): unknown };
      const original = prototype.getExtension;
      prototype.getExtension = function (name) {
        return name === 'EXT_float_blend' ? null : original.call(this, name);
      };
    });
    const capabilityError = new Promise<string>((resolve) =>
      unsupported.once('pageerror', (error) => resolve(error.message)),
    );
    await unsupported.goto(url);
    assert.match(await capabilityError, /requires WebGL2.*float blending/);
    await fs.writeFile(
      path.join(output, 'results.json'),
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          browser: browser.version(),
          results,
          edges,
          coveredRange,
          textured,
          glb,
          reference,
          worlds,
          large,
          small,
          lifetimes,
          pointSize,
          disposed,
          errors,
        },
        null,
        2,
      ),
    );
  },
);
