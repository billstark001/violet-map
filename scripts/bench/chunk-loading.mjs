import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { chromiumExecutablePath } from '../helpers/browser.mjs';
import { assertFullDetailCoverage } from './loading-assertions.mjs';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    world: { type: 'string' },
    seconds: { type: 'string', default: '600' },
    out: { type: 'string', default: 'LOCAL_loading_acceptance' },
    x: { type: 'string', default: '-28.3' },
    y: { type: 'string', default: '79.4' },
    z: { type: 'string', default: '-25.1' },
    yaw: { type: 'string', default: '155.7' },
    pitch: { type: 'string', default: '-9.8' },
    cache: { type: 'string', default: 'on' },
    faults: { type: 'boolean', default: false },
    profile: { type: 'boolean', default: false },
    compare: { type: 'string' },
    gpu: { type: 'string', default: process.platform === 'win32' ? 'd3d11' : 'default' },
  },
});

assert.ok(values.url && values.world, '--url and --world are required');

const seconds = Number(values.seconds);

assert.ok(Number.isInteger(seconds) && seconds >= 60 && seconds <= 3600, '--seconds must be 60..3600');

assert.ok(['on', 'off'].includes(values.cache), '--cache must be on or off');

const position = Object.fromEntries(['x', 'y', 'z', 'yaw', 'pitch'].map((k) => [k, Number(values[k])]));

assert.ok(Object.values(position).every(Number.isFinite), 'camera coordinates must be finite');

const out = path.resolve(values.out);

await fs.mkdir(out, { recursive: true });

const report = {
  startedAt: new Date().toISOString(),
  options: values,
  samples: [],
  snapshots: [],
  faults: [],
  failures: [],
  consoleErrors: [],
  responses: [],
  network: { requests: 0, responseBodyBytes: 0, artifactBodies: 0, artifactBodyBytes: 0 },
};
const browser = await chromium.launch({
  headless: true,
  executablePath: chromiumExecutablePath(),
  args:
    values.gpu === 'd3d11' ? ['--use-angle=d3d11'] : values.gpu === 'software' ? ['--enable-unsafe-swiftshader'] : [],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: 'en-US',
  acceptDownloads: true,
});

await context.addInitScript(() => {
  localStorage.setItem('violet-map:language', 'en');
  const probe = (window.__loadingProbe = {
    instances: [],
    chunkSends: 0,
    meshSends: 0,
    replies: 0,
    dropped: 0,
    dropNextMesh: false,
    active: new Map(),
  });
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args);
      const instance = { worker: this, live: true };
      probe.instances.push(instance);
      const send = this.postMessage.bind(this);
      const terminate = this.terminate.bind(this);
      this.postMessage = (message, ...rest) => {
        if (message.type === 'chunk') probe.chunkSends++;
        if (message.type === 'mesh' || message.type === 'lod') {
          probe.meshSends++;
          probe.active.set(message.version, performance.now());
          if (probe.dropNextMesh) {
            probe.dropNextMesh = false;
            probe.dropped++;
            return;
          }
        }
        return send(message, ...rest);
      };
      this.addEventListener('message', ({ data }) => {
        if (['meshResult', 'lodResult', 'meshError'].includes(data.type)) {
          probe.replies++;
          probe.active.delete(data.version);
        }
      });
      this.terminate = () => {
        instance.live = false;
        probe.active.clear();
        terminate();
      };
    }
  };
});

const page = await context.newPage();
const networkTasks = new Set();

page.on('requestfinished', (request) => {
  const task = request
    .sizes()
    .then((sizes) => {
      report.network.requests++;
      report.network.responseBodyBytes += sizes.responseBodySize;
      if (/\/api\/resources\/[^/]+\/[^/]+\/|\/objects\//.test(new URL(request.url()).pathname)) {
        report.network.artifactBodies++;
        report.network.artifactBodyBytes += sizes.responseBodySize;
      }
    })
    .catch(() => {})
    .finally(() => networkTasks.delete(task));
  networkTasks.add(task);
});

page.on('pageerror', (error) => report.failures.push(error.stack || error.message));

page.on('console', (message) => {
  if (message.type() === 'error') report.consoleErrors.push(message.text());
});

// Coverage is observed from the viewer's own leased response. Ungenerated
// source cells are valid holes, but a generated cell cannot silently stay coarse.
const sourceCoverage = new Map();

page.on('response', async (response) => {
  const coveragePath = new URL(response.url()).pathname.match(/\/api\/worlds\/([^/]+)\/([^/]+)\/chunk-coverage$/);
  if (response.ok() && coveragePath) {
    const coverage = await response.json().catch(() => undefined);
    if (coverage) {
      const key = `${decodeURIComponent(coveragePath[1])}\0${decodeURIComponent(coveragePath[2])}`;
      sourceCoverage.set(key, {
        chunks: new Set(coverage.chunks.map(({ cx, cz }) => `${cx},${cz}`)),
        regions: new Map(
          coverage.regions.map(({ x, z, mask }) => [
            `${x},${z}`,
            typeof mask === 'string' ? Buffer.from(mask, 'base64') : undefined,
          ]),
        ),
      });
    }
  }
  if (response.status() >= 400)
    report.responses.push({
      url: response.url(),
      status: response.status(),
      body: await response.text().catch(() => ''),
    });
});

let resolveFailure = false,
  leaseShortened = false,
  bodyExpired = false,
  bodyFailed = false,
  delayedBodies = 0;

if (values.faults) {
  await page.route('**/api/resources/resolve', async (route) => {
    const body = route.request().postDataJSON();
    if (body.selectors?.some((s) => s.kind === 'chunk')) {
      if (!resolveFailure) {
        resolveFailure = true;
        report.faults.push({ kind: 'resolve-503', at: Date.now() });
        await route.fulfill({
          status: 503,
          json: { code: 'RESOURCE_BUSY', message: 'injected temporary admission failure', retryable: true },
        });
        return;
      }
      if (!leaseShortened && body.selectors.length >= 4) {
        const response = await route.fetch({ maxRedirects: 0 });
        const batch = await response.json();
        assert.equal(response.status(), 200);
        batch.validUntil = Date.now() + 1500;
        leaseShortened = true;
        report.faults.push({ kind: 'short-lease', at: Date.now() });
        await route.fulfill({ response, json: batch });
        return;
      }
    }
    await route.continue();
  });
  await page.route('**/api/resources/*/chunk/*', async (route) => {
    if (delayedBodies < 4) {
      delayedBodies++;
      await new Promise((resolve) => setTimeout(resolve, 2200));
    }
    if (!bodyExpired) {
      bodyExpired = true;
      report.faults.push({ kind: 'body-409', at: Date.now() });
      await route.fulfill({
        status: 409,
        json: { code: 'RESOURCE_VIEW_EXPIRED', message: 'injected expired handoff', retryable: true },
      });
      return;
    }
    if (!bodyFailed) {
      bodyFailed = true;
      report.faults.push({ kind: 'body-503', at: Date.now() });
      await route.fulfill({
        status: 503,
        json: { code: 'RESOURCE_BUSY', message: 'injected temporary body failure', retryable: true },
      });
      return;
    }
    await route.continue();
  });
}

const sample = async (phase) => {
  const row = await page.evaluate(() => {
    const p = window.__loadingProbe;
    const text = document.body.innerText;
    return {
      t: performance.now(),
      text: text.slice(text.indexOf('Diagnostics')),
      chunkSends: p.chunkSends,
      meshSends: p.meshSends,
      replies: p.replies,
      active: p.active.size,
      oldestTaskMs: Math.max(0, ...[...p.active.values()].map((t) => performance.now() - t)),
      workersCreated: p.instances.length,
      dropped: p.dropped,
      heap: performance.memory?.usedJSHeapSize,
    };
  });
  row.phase = phase;
  report.samples.push(row);
  await fs.writeFile(path.join(out, 'live.json'), JSON.stringify(row, null, 2));
  console.log(
    JSON.stringify({
      phase,
      t: Math.round(row.t / 1000),
      chunkSends: row.chunkSends,
      meshSends: row.meshSends,
      active: row.active,
      workersCreated: row.workersCreated,
      dropped: row.dropped,
    }),
  );
  return row;
};

const snapshot = async (label) => {
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download snapshot', exact: true }).click();
  const file = path.join(out, label + '.json');
  await (await downloading).saveAs(file);
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  report.snapshots.push({
    label,
    capturedAt: value.capturedAt,
    activity: value.chunkManager.activity,
    workers: value.chunkManager.workers,
    stats: value.chunkManager.stats,
  });
  return value;
};

const assertSettled = (value) => {
  assert.equal(value.camera.viewMode, 'perspective');
  const manager = value.chunkManager;
  assert.ok(
    manager.chunks.some((c) => c.displayed !== 'none'),
    'terrain never appeared',
  );
  assertFullDetailCoverage(manager, values.world, sourceCoverage);
  assert.equal(manager.chunks.filter((c) => c.state === 'error').length, 0, 'unrecovered error chunks');
  assert.equal(manager.chunks.filter((c) => c.dirty).length, 0, 'terrain invalidation never settled');
  assert.equal(manager.stats.retryingChunks, 0, 'retries never settled');
  assert.deepEqual(
    [
      manager.workers.checking,
      manager.workers.fetching,
      manager.stats.hashQueued,
      manager.stats.fetchQueued,
      manager.stats.meshQueued,
      manager.workers.activeMeshTasks,
      manager.workers.cacheLookups,
      manager.workers.waitingMeshes,
    ],
    [0, 0, 0, 0, 0, 0, 0, 0],
    'loading did not settle',
  );
  assert.ok(
    manager.chunks.length <= manager.scheduling.trackedChunkLimit,
    'tracked chunk limit exceeded after settling',
  );
};

const waitSettled = async (label) => {
  let previous,
    stableSince = Date.now();
  const started = Date.now();
  let lastFailure;
  while (Date.now() - started < 150000) {
    await page.waitForTimeout(5000);
    const row = await sample(label);
    const signature = [row.chunkSends, row.meshSends, row.active].join(':');
    if (signature !== previous) {
      previous = signature;
      stableSince = Date.now();
    }
    if (Date.now() - stableSince >= 15000 && row.active === 0 && /Queue H0 F0 M0/.test(row.text)) {
      const value = await snapshot(label);
      try {
        assertSettled(value);
        return value;
      } catch (error) {
        if (!(error instanceof assert.AssertionError)) throw error;
        lastFailure = error;
        stableSince = Date.now();
      }
    }
  }
  await snapshot(label + '-timeout');
  throw Error(label + ' never settled', { cause: lastFailure });
};

const move = async (next) => {
  await page.getByRole('tab', { name: 'View', exact: true }).click();
  for (const [key, value] of Object.entries(next))
    await page.locator('#' + (['yaw', 'pitch'].includes(key) ? 'angle-' : 'coord-') + key).fill(String(value));
  await page.getByRole('button', { name: 'Go', exact: true }).click();
};

try {
  const query = new URLSearchParams({
    world: values.world,
    dimension: 'minecraft:overworld',
    x: values.x,
    y: values.y,
    z: values.z,
    yaw: String((position.yaw * Math.PI) / 180),
    pitch: String((position.pitch * Math.PI) / 180),
    diagnosticDetail: 'standard',
    idbCacheEnabled: String(values.cache === 'on'),
  });
  await page.goto(values.url + '/?' + query);
  await page.waitForFunction((world) => document.querySelector('#world-select')?.value === world, values.world, {
    timeout: 60000,
  });
  assert.equal(await page.locator('#world-select').inputValue(), values.world);
  assert.equal(await page.locator('#view-distance').inputValue(), '8');
  assert.equal(await page.locator('#lod-distance').inputValue(), '12');
  const baseline = await waitSettled('initial-load');
  report.gpu = await page.evaluate(() => {
    const gl = document.querySelector('#viewport canvas').getContext('webgl2');
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      vendor: gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR),
      renderer: gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS),
    };
  });
  let profiler;
  if (values.profile) {
    profiler = await context.newCDPSession(page);
    await profiler.send('Performance.enable');
    await profiler.send('Profiler.enable');
    await profiler.send('Profiler.start');
    report.metricsBefore = (await profiler.send('Performance.getMetrics')).metrics;
  }
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    await page.waitForTimeout(5000);
    const row = await sample('stationary');
    assert.ok(row.oldestTaskMs < 35000, 'unexpected stalled worker');
  }
  const stationary = await snapshot('stationary-final');
  if (profiler) {
    report.metricsAfter = (await profiler.send('Performance.getMetrics')).metrics;
    const { profile } = await profiler.send('Profiler.stop');
    await fs.writeFile(path.join(out, 'cpu-profile.json'), JSON.stringify(profile));
    await profiler.detach();
  }
  assertSettled(stationary);
  if (values.compare) {
    const reference = JSON.parse(await fs.readFile(values.compare, 'utf8'));
    assert.equal(reference.chunkManager.renderKey, stationary.chunkManager.renderKey);
    assert.deepEqual(reference.camera.pos, stationary.camera.pos);
    const fullGeometry = (value) =>
      value.chunkManager.chunks
        .filter((chunk) => chunk.displayed === 'full')
        .map((chunk) => [chunk.key, chunk.meshBytes])
        .sort(([a], [b]) => a.localeCompare(b));
    assert.deepEqual(fullGeometry(stationary), fullGeometry(reference), 'full geometry changed with cache policy');
    report.geometryCompared = fullGeometry(stationary).length;
  }
  for (const key of ['chunkDispatches', 'meshRequests', 'meshApplications', 'retries'])
    assert.equal(
      stationary.chunkManager.activity[key],
      baseline.chunkManager.activity[key],
      key + ' kept growing in a stationary view',
    );
  await page.screenshot({ path: path.join(out, 'stationary.png') });
  if (values.faults) {
    assert.ok(
      resolveFailure && leaseShortened && bodyExpired && bodyFailed && delayedBodies === 4,
      'not all transport faults were exercised',
    );
    assert.ok(stationary.chunkManager.activity.retries >= 2, 'transport errors did not exercise retry recovery');
    await move({ ...position, yaw: position.yaw + 180 });
    await waitSettled('rotated');
    await page.evaluate(() => {
      const worker = window.__loadingProbe.instances.find((i) => i.live).worker;
      worker.dispatchEvent(new ErrorEvent('error', { message: 'injected worker crash', cancelable: true }));
    });
    report.faults.push({ kind: 'worker-error', at: Date.now() });
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      window.__loadingProbe.dropNextMesh = true;
    });
    await move({ ...position, x: position.x + 96, y: position.y + 16 });
    await page.waitForFunction(() => window.__loadingProbe.dropped === 1, null, { timeout: 30000 });
    const recovered = await waitSettled('worker-watchdog');
    assert.ok(recovered.chunkManager.workers.restarts >= 2, 'worker errors and stalled jobs did not both recover');
    assert.equal(recovered.chunkManager.workers.count, stationary.chunkManager.workers.count);
    await move(position);
    await waitSettled('return-to-origin');
    const supported = await page.evaluate(() => {
      const gl = document.querySelector('#viewport canvas').getContext('webgl2');
      const extension = gl.getExtension('WEBGL_lose_context');
      window.__contextFault = extension;
      if (extension) extension.loseContext();
      return !!extension;
    });
    assert.ok(supported, 'context-loss injection is unavailable');
    await page.waitForTimeout(500);
    await page.evaluate(() => window.__contextFault.restoreContext());
    await page.waitForFunction(() => !document.querySelector('#viewport canvas').getContext('webgl2').isContextLost());
    await page.waitForTimeout(1000);
    const restored = await snapshot('context-restored');
    assertSettled(restored);
    assert.equal(restored.transparency.contextLost, false);
    await page.screenshot({ path: path.join(out, 'context-restored.png') });
    report.faults.push({ kind: 'webgl-context-restored', at: Date.now() });
  }
  assert.deepEqual(report.failures, []);
  assert.ok(
    report.responses.every((r) => {
      if (/injected/.test(r.body)) return true;
      let body;
      try {
        body = JSON.parse(r.body);
      } catch {
        return false;
      }
      return (
        body.retryable === true &&
        ((r.status === 503 && body.code === 'RESOURCE_BUSY') ||
          (r.status === 409 && body.code === 'RESOURCE_VIEW_EXPIRED'))
      );
    }),
    'unexpected HTTP errors',
  );
  assert.ok(
    report.consoleErrors.every((message) => /status of (409|503)/.test(message)),
    'unexpected console errors',
  );
  report.passed = true;
} catch (error) {
  report.error = error.stack || String(error);
  process.exitCode = 1;
  console.error(error);
  await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  await snapshot('failure').catch(() => {});
} finally {
  report.finishedAt = new Date().toISOString();
  await Promise.allSettled([...networkTasks]);
  await browser.close();
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
}
