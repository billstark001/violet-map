import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execute = promisify(execFile);
const sweep = JSON.parse(await fs.readFile('artifacts/resource-acceptance/capacity-benchmark.json', 'utf8'));

const fingerprint = async () => {
  const hash = createHash('sha256');
  for (const file of sweep.sourceFiles) {
    hash.update(file);
    hash.update(await fs.readFile(file));
  }
  return hash.digest('hex');
};

const implementationDigest = await fingerprint();

if (implementationDigest !== sweep.implementationDigest)
  throw new Error('run the complete sweep against the current implementation first');

const median = (a) => a.toSorted((a, b) => a - b)[Math.floor(a.length / 2)];

const worker = async (strategy, capacity) =>
  JSON.parse(
    (
      await execute(
        process.execPath,
        [
          '--import',
          'tsx',
          '--conditions=development',
          'scripts/bench/resources.ts',
          '--worker',
          JSON.stringify(['scan', strategy, capacity, 0]),
        ],
        { timeout: 60000, maxBuffer: 1024 ** 2 },
      )
    ).stdout,
  );

const cases = [];

for (const capacity of [262144, 262145, 1048576]) {
  const pairs = [];
  for (let i = 0; i < sweep.fixture.runs; i++) {
    let baseline, candidate;
    if (i % 2 === 0) {
      baseline = await worker('zero', 0);
      candidate = await worker('tiny-lfu', capacity);
    } else {
      candidate = await worker('tiny-lfu', capacity);
      baseline = await worker('zero', 0);
    }
    pairs.push({ baseline, candidate });
  }
  const p95Ratio = median(pairs.map((p) => p.candidate.p95)) / median(pairs.map((p) => p.baseline.p95));
  const cpuRatio = median(pairs.map((p) => p.candidate.cpu)) / median(pairs.map((p) => p.baseline.cpu));
  const row = { capacity, p95Ratio, cpuRatio, pairs };
  cases.push(row);
  console.log(JSON.stringify({ capacity, p95Ratio, cpuRatio }));
}

if (implementationDigest !== (await fingerprint())) throw new Error('benchmark implementation changed');

const report = {
  schemaVersion: 1,
  scope: 'diagnostic interleaved scan recheck, unchanged sweep fixture and limits',
  createdAt: new Date().toISOString(),
  implementationDigest,
  sourceFiles: sweep.sourceFiles,
  cases,
  passed: cases.every(
    (c) =>
      c.p95Ratio <= sweep.fixture.lowBenefitMedianP95Ratio && c.cpuRatio <= sweep.fixture.lowBenefitCpuPerRequestRatio,
  ),
};

await fs.writeFile('artifacts/resource-acceptance/capacity-paired-audit.json', JSON.stringify(report, null, 2) + '\n');

console.log(JSON.stringify({ passed: report.passed }));

if (!report.passed) process.exitCode = 1;
