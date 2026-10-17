import assert from 'node:assert/strict';
import { packIndices } from '../../packages/render/src/meshPacking.js';

const loop = (values: Uint32Array) => {
  const output = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) output[i] = values[i];
  return output;
};
const reports = [];

for (const length of [6144, 98_304, 393_216]) {
  const backing = Uint32Array.from({ length: length + 8 }, (_, i) => i % 65_536);
  const values = backing.subarray(4, length + 4);
  const operations = { loop: () => loop(values), native: () => packIndices(values, 65_536) };
  const timings = { loop: [] as number[], native: [] as number[] };
  for (let round = 0; round < 40; round++) {
    const names = Object.keys(operations) as (keyof typeof operations)[];
    if (round % 2) names.reverse();
    for (const name of names) {
      const start = performance.now();
      const output = operations[name]();
      const elapsed = performance.now() - start;
      assert.deepEqual(output, new Uint16Array(values));
      if (round >= 10) timings[name].push(elapsed);
    }
  }
  reports.push({
    length,
    p50Ms: Object.fromEntries(
      Object.entries(timings).map(([name, times]) => [name, times.toSorted((a, b) => a - b)[15]]),
    ),
  });
}

console.log(
  JSON.stringify(
    {
      node: process.version,
      measuredRounds: 30,
      includes: 'index conversion and allocation; correctness checks excluded',
      reports,
    },
    null,
    2,
  ),
);
