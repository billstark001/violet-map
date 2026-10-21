import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const project = fileURLToPath(new URL('../../', import.meta.url));
const moduleUrl = new URL('../../packages/server/src/content.ts', import.meta.url).href;
const script = `
  import { createRequire } from 'node:module';
  import path from 'node:path';
  const started = performance.now();
  await import(${JSON.stringify(moduleUrl)});
  const elapsed = performance.now() - started;
  globalThis.gc();
  const require = createRequire(import.meta.url);
  console.log(JSON.stringify({ importMs: elapsed, memory: process.memoryUsage(), sharpLoaded: Object.keys(require.cache).map(file => file.split(path.sep).join('/')).some(file => file.includes('/@img/sharp-') || file.includes('/sharp/')) }));
`;
const samples: { importMs: number; memory: NodeJS.MemoryUsage; sharpLoaded: boolean }[] = [];

for (let round = 0; round < 5; round++) {
  const result = await execute(
    process.execPath,
    ['--expose-gc', '--import', 'tsx', '--conditions=development', '--input-type=module', '-e', script],
    { cwd: project },
  );
  samples.push(JSON.parse(result.stdout));
}

const median = (numbers: number[]) => numbers.toSorted((a, b) => a - b)[2];

console.log(
  JSON.stringify(
    {
      node: process.version,
      processes: samples.length,
      includes:
        'cold content-service module import and post-GC process memory; process launch and media import excluded',
      importP50Ms: median(samples.map((sample) => sample.importMs)),
      heapP50Bytes: median(samples.map((sample) => sample.memory.heapUsed)),
      rssP50Bytes: median(samples.map((sample) => sample.memory.rss)),
      sharpLoaded: samples.map((sample) => sample.sharpLoaded),
    },
    null,
    2,
  ),
);
