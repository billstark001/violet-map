import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execute } from '../helpers/process.mjs';
import { createRequire } from 'node:module';

const { decode } = createRequire(new URL('../../packages/resources/package.json', import.meta.url))('@msgpack/msgpack');

const baselineRevision = 'da048f422e155861f153088e2a73ad4ac0d3fce2';
const project = fileURLToPath(new URL('../../', import.meta.url));
const requests = 500;
const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];

if (process.argv[2] === '--worker') {
  const [repo, fixture, mode] = JSON.parse(process.argv[3]);
  const load = (name: string) => import(pathToFileURL(path.join(repo, 'packages/server/src', name + '.ts')).href);
  const { loadServerConfig } = await load('configuration');
  const { createServices } = await load('services');
  const { createApp } = await load('app');
  const config = loadServerConfig({
    cwd: fixture,
    env: {
      DEPLOYMENT_PROFILE: 'public',
      DATA_DIR: path.join(fixture, 'data'),
      WORLDS_DIR: path.join(fixture, 'worlds'),
      ASSETS_DIRS: path.join(fixture, 'assets'),
      ...(mode === 'zero' ? { RESOURCES_CACHE_MEMORY_BYTES: '0' } : {}),
    },
  });
  const services = await createServices(config);
  try {
    const source = services.mounts.worlds.storage;
    const counts = { get: 0, head: 0, list: 0, readBytes: 0 };
    for (const [method, metric] of [
      ['read', 'get'],
      ['readRange', 'get'],
      ['stat', 'head'],
      ['list', 'list'],
      ['listDirectories', 'list'],
    ] as const) {
      const original = source[method].bind(source);
      source[method] = async (...args: unknown[]) => {
        counts[metric]++;
        const value = await original(...args);
        if (value instanceof Uint8Array) counts.readBytes += value.length;
        return value;
      };
    }
    const app = createApp(config, services);
    const startCold = performance.now();
    const head = mode === 'original' ? undefined : await services.resources.head('fixture');
    const startupRootMs = performance.now() - startCold;
    let apiBodyBytes = 0,
      apiMetadataBytes = 0;
    const request = async () => {
      let response;
      if (mode === 'original') response = await app.request('/api/worlds/fixture/minecraft%3Aoverworld/chunk/0/0');
      else {
        const resolving = await app.request('/api/resources/resolve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            viewId: head.viewId,
            selectors: [{ kind: 'chunk', world: 'fixture', dimension: 'minecraft:overworld', cx: 0, cz: 0 }],
          }),
        });
        assert.equal(resolving.status, 200);
        const metadata = await resolving.text();
        apiMetadataBytes += Buffer.byteLength(metadata);
        response = await app.request(JSON.parse(metadata).resources[0].resource.url);
      }
      assert.equal(response.status, 200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      apiBodyBytes += bytes.length;
      const payload = decode(bytes) as { data: Uint8Array };
      const hash = createHash('sha256').update(payload.data).digest('hex');
      return hash;
    };
    const expected = await request();
    for (let i = 0; i < 50; i++) assert.equal(await request(), expected);
    const before = { ...counts };
    apiBodyBytes = apiMetadataBytes = 0;
    const generation = services.resources?.repository?.metrics.generation ?? null;
    const latencies: number[] = [];
    const cpu = process.cpuUsage();
    for (let i = 0; i < requests; i++) {
      const start = performance.now();
      assert.equal(await request(), expected);
      latencies.push(performance.now() - start);
    }
    const used = process.cpuUsage(cpu);
    latencies.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        mode,
        requests,
        p50: latencies[Math.floor(requests * 0.5)],
        p95: latencies[Math.floor(requests * 0.95)],
        cpuPerRequest: (used.user + used.system) / requests,
        startupRootMs,
        digest: expected,
        apiBodyBytes,
        apiMetadataBytes,
        source: Object.fromEntries(
          Object.entries(counts).map(([key, value]) => [key, value - before[key as keyof typeof before]]),
        ),
        generated: generation === null ? null : services.resources.repository.metrics.generation - generation,
        rss: process.memoryUsage().rss,
      }),
    );
  } finally {
    await services.close();
  }
} else {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-original-comparison-'));
  try {
    const archive = path.join(temp, 'baseline.tar'),
      baseline = path.join(temp, 'baseline'),
      fixture = path.join(temp, 'fixture');
    await fs.mkdir(baseline);
    await fs.mkdir(fixture);
    await execute('git', ['archive', '--format=tar', '--output=' + archive, baselineRevision], { cwd: project });
    await execute('tar', ['-xf', archive, '-C', baseline]);
    await execute('pnpm', ['install', '--offline', '--frozen-lockfile', '--ignore-scripts'], {
      cwd: baseline,
      timeout: 120000,
      maxBuffer: 4 * 1024 ** 2,
    });
    const { resourceFixture } = await import('../acceptance/helpers/resources.js');
    await resourceFixture(fixture);
    const reports = [];
    for (const mode of ['original', 'zero', 'current']) {
      const runs = [];
      for (let run = 0; run < 3; run++) {
        const result = await execute(
          process.execPath,
          [
            '--import',
            'tsx',
            '--conditions=development',
            fileURLToPath(import.meta.url),
            '--worker',
            JSON.stringify([mode === 'original' ? baseline : project, fixture, mode]),
          ],
          { cwd: project, timeout: 60000, maxBuffer: 1024 ** 2 },
        );
        runs.push(JSON.parse(result.stdout.trim().split('\n').at(-1)!));
      }
      reports.push({
        mode,
        p95: median(runs.map((r) => r.p95)),
        cpuPerRequest: median(runs.map((r) => r.cpuPerRequest)),
        runs,
      });
    }
    assert.equal(new Set(reports.flatMap((r) => r.runs.map((s) => s.digest))).size, 1);
    const report = {
      schemaVersion: 1,
      baselineRevision,
      node: process.version,
      independentProcesses: true,
      scope:
        'in-process HTTP handlers; original single chunk endpoint versus resource resolve+GET; frozen identical override/MCA fixture; original has its original source cache; zero/current use the new protocol',
      reports,
    };
    await fs.mkdir(path.join(project, 'artifacts/resource-acceptance'), { recursive: true });
    await fs.writeFile(
      path.join(project, 'artifacts/resource-acceptance/original-baseline.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
    console.log(
      JSON.stringify(
        reports.map(({ mode, p95, cpuPerRequest }) => ({ mode, p95, cpuPerRequest })),
        null,
        2,
      ),
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
