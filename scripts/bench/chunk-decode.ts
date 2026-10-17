import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gunzipSync, inflate, inflateSync } from 'node:zlib';
import { getRegionChunk, getRegionChunkRecord } from '../../packages/core/src/region.js';

// Select only the eight largest compressed records from each explicitly supplied
// region. No world files are copied into the repository or benchmark output.
const paths = process.argv.slice(2);
assert.ok(paths.length > 0, 'provide one or two representative .mca paths');
assert.ok(paths.length <= 2, 'at most two regions are needed for this benchmark');
const inflateAsync = promisify(inflate);
const gunzipAsync = promisify(gunzip);
const samples = [];
for (const path of paths) {
  const region = await readFile(resolve(path));
  const records = [];
  for (let z = 0; z < 32; z++) {
    for (let x = 0; x < 32; x++) {
      const record = getRegionChunkRecord(region, x, z);
      if (record) records.push({ region, x, z, ...record });
    }
  }
  samples.push(...records.toSorted((a, b) => b.payload.byteLength - a.payload.byteLength).slice(0, 8));
}
assert.ok(samples.length > 0, 'regions contain no supported chunks');
const codecs = {
  pako: (sample: (typeof samples)[number]) => getRegionChunk(sample.region, sample.x, sample.z)!,
  'node-sync': (sample: (typeof samples)[number]) => {
    if (sample.compression === 1) return new Uint8Array(gunzipSync(sample.payload));
    if (sample.compression === 2) return new Uint8Array(inflateSync(sample.payload));
    return sample.payload.slice();
  },
  'node-async': async (sample: (typeof samples)[number]) => {
    if (sample.compression === 1) return new Uint8Array(await gunzipAsync(sample.payload));
    if (sample.compression === 2) return new Uint8Array(await inflateAsync(sample.payload));
    return sample.payload.slice();
  },
};
const decoded = samples.map(codecs.pako);
const rounds = 20;
const results = [];
for (const [name, decode] of Object.entries(codecs)) {
  for (let i = 0; i < samples.length; i++) assert.deepEqual(await decode(samples[i]), decoded[i]);
  const elapsed = [];
  let longestTimerDelayMs = 0;
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    longestTimerDelayMs = Math.max(longestTimerDelayMs, now - previous);
    previous = now;
  }, 1);
  try {
    for (let round = 0; round < rounds; round++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const start = performance.now();
      for (const sample of samples) await decode(sample);
      elapsed.push(performance.now() - start);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  } finally {
    clearInterval(timer);
  }
  const sorted = elapsed.toSorted((a, b) => a - b);
  results.push({
    name,
    batchP50Ms: sorted[Math.floor(rounds / 2)],
    batchP95Ms: sorted[rounds - 1],
    longestTimerDelayMs,
  });
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      samples: samples.length,
      rounds,
      compressedBytes: samples.map((s) => s.payload.byteLength),
      decodedBytes: decoded.map((s) => s.byteLength),
      results,
    },
    null,
    2,
  ),
);
