import { waitForProcessOutput } from '../acceptance/helpers/process-startup.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Measure native IndexedDB cloning against immutable CPU-buffer reuse. The
// ephemeral browser profile is removed by Playwright; no real viewer data is used.
const project = fileURLToPath(new URL('../../', import.meta.url));
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '0'], {
  cwd: fileURLToPath(new URL('../../packages/web/', import.meta.url)),
  env: { ...process.env, FORCE_COLOR: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  const [origin] = await waitForProcessOutput(vite, /http:\/\/127\.0\.0\.1:\d+(?=\/|\s)/, 'Vite');
  const browser = await chromium.launch({
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
      (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined),
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.addInitScript('globalThis.__name = (fn) => fn');
    await page.goto(`${origin}/test/mesh-cache-browser.html`);
    const rounds = Number(process.argv[2] ?? 100);
    assert.ok(Number.isSafeInteger(rounds) && rounds > 0 && rounds <= 10000, 'rounds must be 1..10000');
    const result = await page.evaluate(
      async ({ rounds }) => {
        const modulePath = '/src/meshCache.ts';
        const { clearMeshCache, getCachedFull, putCachedFull, setMeshCacheEnabled } = (await import(
          modulePath
        )) as typeof import('../../packages/web/src/meshCache.js');
        const summaries = [];
        const parts = {
          world: 'benchmark',
          dimension: 'minecraft:overworld',
          renderKey: 'benchmark',
          cx: 0,
          cz: 0,
          contentKey: 'benchmark',
        };
        const percentile = (values: number[], p: number) =>
          values.toSorted((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
        for (const bytes of [4 * 1024, 256 * 1024, 4 * 1024 * 1024]) {
          const sections = [
            {
              sy: 0,
              layers: {
                opaque: {
                  positions: new Uint16Array(bytes / 2),
                  colors: new Uint8Array(),
                  lights: new Uint8Array(),
                  indices: new Uint16Array(),
                },
              },
            },
          ];
          await clearMeshCache();
          await putCachedFull(parts, sections);
          for (const mode of ['cold-idb', 'warm-memory']) {
            const samples = [];
            for (let i = 0; i < rounds + 10; i++) {
              if (mode === 'cold-idb') {
                setMeshCacheEnabled(false);
                setMeshCacheEnabled(true);
              }
              const start = performance.now();
              const hit = await getCachedFull(parts);
              if (hit?.[0]?.layers.opaque?.positions.byteLength !== bytes)
                throw new Error('invalid benchmark cache hit');
              if (i >= 10) samples.push(performance.now() - start);
            }
            summaries.push({ mode, bytes, rounds, p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95) });
          }
        }
        await clearMeshCache();
        return { userAgent: navigator.userAgent, summaries };
      },
      { rounds },
    );
    console.log(JSON.stringify({ project, ...result }, null, 2));
  } finally {
    await browser.close();
  }
} finally {
  vite.kill('SIGTERM');
}
