import assert from 'node:assert/strict';
import { getRegionChunk } from '../../packages/core/src/region.js';
import { parseNbt, toLongs } from '../../packages/core/src/nbt.js';
import { BitArray } from '../../packages/core/src/world.js';
import { loadHardRegionSamples } from './helpers/region-samples.js';

const cases = new Map<string, { bits: number; data: BigUint64Array; length: number }>();
for (const sample of await loadHardRegionSamples(process.argv.slice(2))) {
  const root = parseNbt(getRegionChunk(sample.region, sample.x, sample.z)!);
  for (const section of root.sections)
    for (const [kind, input, length, minimum] of [
      ['block', section.block_states, 4096, 4],
      ['biome', section.biomes, 64, 1],
    ] as const) {
      if (!input?.data || !input.palette?.length) continue;
      const bits = Math.max(minimum, Math.ceil(Math.log2(input.palette.length)));
      cases.set(`${kind}-${bits}`, { bits, data: toLongs(input.data), length });
    }
}
assert.ok(cases.size > 0);
const reference = (bits: number, data: BigUint64Array, out: Uint16Array) => {
  const perLong = Math.floor(64 / bits),
    mask = (1n << BigInt(bits)) - 1n,
    shift = BigInt(bits);
  let index = 0;
  for (const packed of data) {
    let remaining = packed;
    for (let n = 0; n < perLong && index < out.length; n++) {
      out[index++] = Number(remaining & mask);
      remaining >>= shift;
    }
    if (index === out.length) break;
  }
};
const results = [];
let checksum = 0;
for (const [name, input] of cases) {
  const packed = new BitArray(input.bits, input.data);
  const expected = new Uint16Array(input.length),
    actual = new Uint16Array(input.length);
  reference(input.bits, input.data, expected);
  packed.copyTo(actual);
  assert.deepEqual(actual, expected);
  for (let index = 0; index < input.length; index++) assert.equal(packed.get(index), expected[index]);
  const samples: Record<string, number[]> = { bigint: [], current: [] };
  for (let round = 0; round < 25; round++)
    for (const mode of ['bigint', 'current']) {
      const start = performance.now();
      for (let repeat = 0; repeat < 500; repeat++) {
        if (mode === 'bigint') reference(input.bits, input.data, actual);
        else packed.copyTo(actual);
        checksum = (checksum + actual[repeat % actual.length]) >>> 0;
      }
      if (round >= 5) samples[mode].push((performance.now() - start) / 500);
    }
  const percentile = (values: number[], p: number) => values.toSorted((a, b) => a - b)[Math.floor(values.length * p)];
  results.push({
    name,
    values: input.length,
    bigintP50Ms: percentile(samples.bigint, 0.5),
    currentP50Ms: percentile(samples.current, 0.5),
    currentP95Ms: percentile(samples.current, 0.95),
  });
}
console.log(JSON.stringify({ node: process.version, measuredRounds: 20, repeat: 500, checksum, results }, null, 2));
