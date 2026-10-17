import assert from 'node:assert/strict';
import { getRegionChunk } from '../../packages/core/src/region.js';
import { parseNbt } from '../../packages/core/src/nbt.js';
import { parseChunkColumn } from '../../packages/core/src/world.js';
import { loadHardRegionSamples } from './helpers/region-samples.js';

const records = await loadHardRegionSamples(process.argv.slice(2));
const chunks = records.map((sample) => parseNbt(getRegionChunk(sample.region, sample.x, sample.z)!));
const heights = (root: unknown) => {
  const column = parseChunkColumn(root);
  const result = new Int32Array(256);
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) result[z * 16 + x] = column.heightAt(x, z);
  return result;
};
const withoutHeightmaps = chunks.map((chunk) => ({ ...chunk, Heightmaps: undefined }));
let gridChecked = 0;
for (const region of new Set(records.map((record) => record.region))) {
  for (const x of [0, 8, 16, 24, 31])
    for (const z of [0, 8, 16, 24, 31]) {
      const data = getRegionChunk(region, x, z);
      if (!data) continue;
      const chunk = parseNbt(data);
      assert.deepEqual(
        heights(chunk),
        heights({ ...chunk, Heightmaps: undefined }),
        `height mismatch at local ${x},${z}`,
      );
      gridChecked++;
    }
}
for (let index = 0; index < chunks.length; index++) {
  assert.ok(parseChunkColumn(chunks[index]).heightMap, 'sample must exercise the stored height map');
  assert.deepEqual(heights(chunks[index]), heights(withoutHeightmaps[index]), 'stored and scanned heights must agree');
}
const summaries = [];
for (const [mode, inputs] of [
  ['scanned', withoutHeightmaps],
  ['stored-heightmap', chunks],
] as const) {
  const samples = [];
  for (let round = 0; round < 35; round++) {
    const start = performance.now();
    for (const input of inputs) heights(input);
    if (round >= 5) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  summaries.push({ mode, batchP50Ms: samples[15], batchP95Ms: samples[28] });
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      chunks: chunks.length,
      gridChecked,
      rounds: 30,
      includes: 'parseChunkColumn and all 256 height queries; NBT decompression excluded',
      summaries,
    },
    null,
    2,
  ),
);
