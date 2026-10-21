import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { LruCache } from '../../packages/core/src/cache.js';
import { BlobRepository, InvalidationCoordinator, MemoryActionIndex } from '../../packages/resources/src/index.js';
import { chunkIdentity } from '../../packages/resources/src/chunkIdentity.js';
import { prepareChunkArtifact } from '../../packages/resources/src/chunkArtifact.js';

const fixture = JSON.parse(await fs.readFile(new URL('./resources-fixture.json', import.meta.url), 'utf8'));
const input = new Uint8Array(fixture.objectBytes);

for (let i = 0; i < input.length; i++) input[i] = (i * 31 + (i >>> 8)) & 255;

const overhead =
  prepareChunkArtifact({ cx: 0, cz: 0, data: input }, chunkIdentity(input)).generate().length - input.length;
const compressed = deflateSync(input.subarray(0, input.length - overhead));
const digest = (s: string) => createHash('sha256').update(s).digest('hex');

function trace(name: string, i: number) {
  return name === 'hot'
    ? i % 10 < 9
      ? i % fixture.hotObjects
      : 1000 + i
    : name === 'edit'
      ? (i % 32) + Math.floor(i / 100) * 32
      : name === 'resolve-get'
        ? Math.floor(i / 2) % fixture.hotObjects
        : i;
}

async function measure(name: string, strategy: string, capacity: number, rate = 0) {
  const repository = new BlobRepository({
    memoryBytes: strategy === 'zero' ? 0 : capacity,
    workBytes: 8 * 1024 ** 2,
    handoffBytes: 8 * 1024 ** 2,
    handoffMs: 30000,
    maxTasks: 64,
    index: new MemoryActionIndex(2 * 1024 ** 2),
    source: new InvalidationCoordinator(),
  });
  const lru = new LruCache<string, Uint8Array>({
    maxEntries: 4096,
    maxWeight: capacity,
    weightOf: (bytes) => bytes.length,
  });
  if (strategy === 'lru') {
    // Reference policy adapter is confined to this benchmark. The repository,
    // action index, generation, handoff and integrity path are unchanged.
    repository.cache.get = (key) => lru.get(key);
    repository.cache.set = (key, bytes) => {
      lru.set(key, bytes);
      return lru.has(key);
    };
  }
  let deliveredBytes = 0;
  const serve = async (id: number) => {
    const lease = await repository.ensure({
      actionKey: digest(String(id)),
      generation: 0,
      mediaType: 'application/msgpack',
      format: 'chunk-msgpack-v1',
      maxBytes: fixture.objectBytes,
      workBytes: fixture.objectBytes * 4,
      generate: async () => {
        const source = new Uint8Array(inflateSync(compressed));
        new DataView(source.buffer).setUint32(0, id);
        return prepareChunkArtifact({ cx: 0, cz: 0, data: source }, chunkIdentity(source)).generate();
      },
    });
    const read = await repository.acquire(lease.artifact);
    deliveredBytes += read.bytes.length;
    read.release();
  };
  for (let warmup = 0; warmup < fixture.warmupRequests; warmup++) await serve(-warmup - 1);
  const beforeGenerated = repository.metrics.generation;
  deliveredBytes = 0;
  const latencies: number[] = [];
  const queueSamples: number[] = [];
  let maxOutstanding = 0;
  const cpu = process.cpuUsage();
  const start = performance.now();
  const requests = rate ? fixture.loadRequests : fixture.requests;
  if (!rate) {
    for (let i = 0; i < requests; i++) {
      const before = performance.now();
      await serve(trace(name, i));
      latencies.push(performance.now() - before);
    }
  } else {
    // Open-loop arrivals: lateness is charged from the planned arrival rather
    // than dropping delayed requests or measuring only service time.
    let launched = 0;
    const active = new Set<Promise<void>>();
    while (launched < requests || active.size) {
      const now = performance.now();
      const due = Math.min(requests, Math.floor(((now - start) * rate) / 1000) + 1);
      queueSamples.push(Math.max(0, due - launched) + active.size);
      while (launched < due && active.size < 32) {
        const i = launched++;
        const arrival = start + (i * 1000) / rate;
        const job = serve(trace(name, i))
          .then(() => {
            latencies.push(performance.now() - arrival);
          })
          .finally(() => active.delete(job));
        active.add(job);
        maxOutstanding = Math.max(maxOutstanding, due - launched + active.size);
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  const elapsed = performance.now() - start;
  const used = process.cpuUsage(cpu);
  const generated = repository.metrics.generation - beforeGenerated;
  latencies.sort((a, b) => a - b);
  const quarter = Math.max(1, Math.floor(queueSamples.length / 4));
  const average = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  const result = {
    p50: latencies[Math.floor(latencies.length * 0.5)],
    p95: latencies[Math.floor(latencies.length * 0.95)],
    cpu: (used.user + used.system) / requests,
    generated,
    deliveredBytes,
    byteHitRate: 1 - generated / requests,
    sourceGet: generated,
    sourceBytes: generated * compressed.length,
    objectPut: 0,
    uploadedBytes: 0,
    requestsPerSecond: (requests / elapsed) * 1000,
    retainedBytes: strategy === 'lru' ? lru.weight : repository.cache.bytes,
    handoffBytes: repository.handoff.budget.bytes,
    workBytes: repository.work.bytes,
    cacheMetrics: repository.cache.metrics,
    rss: process.memoryUsage().rss,
    temporaryBytes: 0,
    offeredRate: rate,
    maxOutstanding,
    firstQueueMean: average(queueSamples.slice(0, quarter)),
    lastQueueMean: average(queueSamples.slice(-quarter)),
    drainMs: rate ? Math.max(0, elapsed - (requests * 1000) / rate) : 0,
  };
  await repository.close();
  return result;
}

if (process.argv[2] === '--worker') {
  const [name, strategy, capacity, rate] = JSON.parse(process.argv[3]);
  console.log(JSON.stringify(await measure(name, strategy, capacity, rate)));
} else {
  const execute = promisify(execFile);
  const reports: Record<string, any>[] = [];
  const loads: Record<string, any>[] = [];
  const calibrations: Record<string, any>[] = [];
  const sourceFiles = [
    'packages/core/src/resourceCanonical.ts',
    'packages/core/src/cache.ts',
    'packages/storage/src/contentAddressed.ts',
    'packages/resources/src/cache.ts',
    'packages/resources/src/blobRepository.ts',
    'packages/resources/src/budget.ts',
    'packages/resources/src/handoff.ts',
    'packages/resources/src/singleflight.ts',
    'packages/resources/src/catalog/memory.ts',
    'packages/resources/src/chunkArtifact.ts',
    'scripts/bench/resources-fixture.json',
    'pnpm-lock.yaml',
  ];
  const fingerprint = async () => {
    const hash = createHash('sha256');
    for (const file of sourceFiles) {
      hash.update(file);
      hash.update(await fs.readFile(file));
    }
    return hash.digest('hex');
  };
  const implementationDigest = await fingerprint();
  const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
  const worker = async (args: unknown[]) => {
    const result = await execute(
      process.execPath,
      ['--import', 'tsx', '--conditions=development', fileURLToPath(import.meta.url), '--worker', JSON.stringify(args)],
      { timeout: 60000, maxBuffer: 1024 ** 2 },
    );
    return JSON.parse(result.stdout);
  };
  if (process.argv.includes('--smoke')) {
    console.log(JSON.stringify(await worker(['scan', 'zero', 0, 0])));
    process.exit(0);
  }
  for (const name of fixture.traces) {
    for (const capacity of fixture.capacities)
      for (const strategy of fixture.strategies) {
        if (strategy === 'zero' && capacity !== 0) continue;
        const runs = [];
        for (let run = 0; run < fixture.runs; run++) runs.push(await worker([name, strategy, capacity, 0]));
        reports.push({
          trace: name,
          strategy,
          capacity,
          p95: median(runs.map((r) => r.p95)),
          cpu: median(runs.map((r) => r.cpu)),
          runs,
        });
      }
    const baseline = reports.find((r) => r.trace === name && r.strategy === 'zero')!;
    const closedThroughput = median(baseline.runs.map((r: any) => r.requestsPerSecond));
    let throughput = 0;
    for (let attempt = 0; attempt < fixture.maxCalibrationAttempts; attempt++) {
      const rate = closedThroughput * fixture.calibrationStep ** attempt;
      const runs = [];
      for (let run = 0; run < fixture.runs; run++) runs.push(await worker([name, 'zero', 0, rate]));
      const stable =
        median(runs.map((r) => r.drainMs)) < fixture.maxLoadDrainMs &&
        median(runs.map((r) => r.lastQueueMean - r.firstQueueMean)) < fixture.maxQueueGrowth &&
        median(runs.map((r) => r.requestsPerSecond)) >= rate * fixture.minAchievedRateFraction;
      calibrations.push({ trace: name, rate, stable, runs });
      if (stable) {
        throughput = rate;
        break;
      }
    }
    if (!throughput) throw new Error(`zero-retention offered-load calibration is unstable for ${name}`);
    for (const fraction of fixture.loadFractions)
      for (const capacity of fixture.capacities)
        for (const strategy of fixture.strategies) {
          if (strategy === 'zero' && capacity !== 0) continue;
          const runs = [];
          for (let run = 0; run < fixture.runs; run++)
            runs.push(await worker([name, strategy, capacity, throughput * fraction]));
          loads.push({
            trace: name,
            strategy,
            capacity,
            fraction,
            runs,
            stable:
              median(runs.map((r) => r.drainMs)) < fixture.maxLoadDrainMs &&
              median(runs.map((r) => r.lastQueueMean - r.firstQueueMean)) < fixture.maxQueueGrowth,
          });
        }
    console.log(`completed ${name}: capacity scan and 50%/80% open-loop load`);
  }
  const comparisons = reports
    .filter((r) => r.trace === 'scan' && r.strategy === 'tiny-lfu')
    .map((r) => {
      const baseline = reports.find((b) => b.trace === r.trace && b.strategy === 'zero')!;
      return { capacity: r.capacity, p95Ratio: r.p95 / baseline.p95, cpuRatio: r.cpu / baseline.cpu };
    });
  const passed =
    comparisons.every(
      (r) => r.p95Ratio <= fixture.lowBenefitMedianP95Ratio && r.cpuRatio <= fixture.lowBenefitCpuPerRequestRatio,
    ) && loads.filter((r) => r.strategy !== 'lru').every((r) => r.stable);
  const report = {
    schemaVersion: 2,
    fixture,
    scope: 'repository resolve/handoff/GET with immutable prepared inputs; memory retention scan; open-loop load',
    independentProcesses: true,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    createdAt: new Date().toISOString(),
    comparisons,
    passed,
    reports,
    loads,
    calibrations,
    implementationDigest,
    sourceFiles,
  };
  if (implementationDigest !== (await fingerprint()))
    throw new Error('benchmark implementation changed during the run');
  await fs.mkdir('artifacts/resource-acceptance', { recursive: true });
  await fs.writeFile('artifacts/resource-acceptance/capacity-benchmark.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed, comparisons, unstableLoads: loads.filter((r) => !r.stable).length }, null, 2));
  if (!passed) process.exitCode = 1;
}
