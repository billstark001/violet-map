import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LocalStorage } from '../../packages/storage/src/local.js';

assert.equal(process.argv.length, 3, 'provide one representative region/object path');

const file = path.resolve(process.argv[2]);
const storage = new LocalStorage(path.dirname(file));
const key = path.basename(file);
const reference = await fs.readFile(file);
const operations = {
  'copy-after-read': async () => new Uint8Array(await fs.readFile(file)),
  'storage-read': async () => (await storage.read(key))!,
};
const samples = new Map(Object.keys(operations).map((name) => [name, [] as number[]]));

for (let round = 0; round < 35; round++) {
  const names = Object.keys(operations) as (keyof typeof operations)[];
  if (round % 2) names.reverse();
  for (const name of names) {
    const start = performance.now();
    const bytes = await operations[name]();
    if (round >= 5) samples.get(name)!.push(performance.now() - start);
    assert.deepEqual(bytes, new Uint8Array(reference.buffer, reference.byteOffset, reference.byteLength));
    assert.equal(bytes.buffer.byteLength, bytes.byteLength, 'retained buffers have no unrelated pooled bytes');
  }
}

console.log(
  JSON.stringify(
    {
      node: process.version,
      bytes: reference.length,
      rounds: 30,
      includes: 'warm-cache filesystem reads and owned-byte conversion; full byte comparison excluded',
      timings: [...samples].map(([mode, values]) => {
        values.sort((a, b) => a - b);
        return { mode, p50Ms: values[15], p95Ms: values[28] };
      }),
    },
    null,
    2,
  ),
);
