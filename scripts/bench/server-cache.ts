import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { getRegionChunk, getRegionChunkRecord } from '../../packages/core/src/region.js';
import type { ObjectStorage } from '../../packages/core/src/storage.js';
import { createWorldSource } from '../../packages/resources/src/sources/worldChunks.js';
import { CachedStorage } from '../../packages/storage/src/cached.js';
import { LocalStorage } from '../../packages/storage/src/local.js';

// Read-only soak with two explicit regions, small cache budgets and a bounded
// request rate. Run with tsx --expose-gc for comparable post-GC heap samples.
const [worldArgument, durationArgument = '60'] = process.argv.slice(2);

assert.ok(worldArgument, 'provide the world directory');

const worldRoot = path.resolve(worldArgument);
const durationSeconds = Number(durationArgument);

assert.ok(
  Number.isSafeInteger(durationSeconds) && durationSeconds >= 1 && durationSeconds <= 3600,
  'duration must be 1..3600 seconds',
);

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let seed = 20261018;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

const samples: { cx: number; cz: number; digest: string }[] = [];

for (const [rx, rz] of [
  [0, 0],
  [-1, -1],
]) {
  const region = new Uint8Array(
    await fs.readFile(path.join(worldRoot, 'dimensions/minecraft/overworld/region', `r.${rx}.${rz}.mca`)),
  );
  const records = [];
  for (let z = 0; z < 32; z++)
    for (let x = 0; x < 32; x++) {
      const record = getRegionChunkRecord(region, x, z);
      if (record) records.push({ x, z, size: record.payload.length });
    }
  const sorted = records.toSorted((a, b) => b.size - a.size);
  const selected = [
    ...sorted.slice(0, 8),
    ...sorted
      .slice(8)
      .filter(() => random() < 0.1)
      .slice(0, 88),
  ];
  for (const { x, z } of selected)
    samples.push({ cx: rx * 32 + x, cz: rz * 32 + z, digest: hash(getRegionChunk(region, x, z)!) });
}

assert.ok(samples.length >= 16);

const base = new LocalStorage(path.dirname(worldRoot));
const denyWrite = async (): Promise<never> => {
  throw new Error('benchmark storage is read-only');
};
const readOnly: ObjectStorage = {
  kind: 'local',
  read: base.read.bind(base),
  readRange: base.readRange.bind(base),
  stat: base.stat.bind(base),
  list: base.list.bind(base),
  listDirectories: base.listDirectories.bind(base),
  write: denyWrite,
  delete: denyWrite,
  deletePrefix: denyWrite,
};
const storage = new CachedStorage(readOnly);
const sourceOptions = { cache: { regionBytes: 8 * 1024 ** 2, chunkNbtBytes: 1024 ** 2, worldListMs: 0 } };
const store = createWorldSource(storage, sourceOptions);
const world = path.basename(worldRoot);
let batches = 0,
  nextReport = 0;
const timings: number[] = [];
const start = performance.now();

while (performance.now() - start < durationSeconds * 1000) {
  const requested = Array.from({ length: 8 }, () => samples[Math.floor(random() * samples.length)]);
  const before = performance.now();
  const results = await store.readChunks(world, 'minecraft:overworld', requested);
  timings.push(performance.now() - before);
  for (let index = 0; index < requested.length; index++)
    assert.equal(hash(results[index]!.data), requested[index].digest);
  batches++;
  const stats = store.cacheStats();
  assert.ok(
    stats.regionBytes <= sourceOptions.cache.regionBytes && stats.chunkBytes <= sourceOptions.cache.chunkNbtBytes,
  );
  const elapsedSeconds = (performance.now() - start) / 1000;
  if (elapsedSeconds >= nextReport) {
    globalThis.gc?.();
    console.log(
      JSON.stringify({
        elapsedSeconds,
        batches,
        samples: samples.length,
        gc: typeof globalThis.gc === 'function',
        cache: stats,
        memory: process.memoryUsage(),
      }),
    );
    nextReport = elapsedSeconds + 30;
  }
  await setTimeout(250);
}

globalThis.gc?.();

const sorted = timings.toSorted((a, b) => a - b);

console.log(
  JSON.stringify({
    completed: true,
    durationSeconds,
    batches,
    chunks: batches * 8,
    p50Ms: sorted[Math.floor(sorted.length * 0.5)],
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
    cache: store.cacheStats(),
    memory: process.memoryUsage(),
  }),
);
