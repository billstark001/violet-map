import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compareObjectContent } from '../../packages/storage/src/copy.js';
import type { ObjectStorage } from '../../packages/core/src/storage.js';

assert.equal(process.argv.length, 3, 'provide one representative region/object path');

const bytes = await readFile(process.argv[2]);
const targetBytes = new Uint8Array(bytes);
const reader = (value: Uint8Array) =>
  ({
    stat: async () => ({ path: 'sample', size: value.length }),
    read: async () => value,
  }) as ObjectStorage;
const source = reader(bytes),
  target = reader(targetBytes);
const oldHash = async (input: Uint8Array) => {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer,
  );
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('');
};
const operations = {
  'copy-before-digest': async () => {
    await target.stat('sample');
    const [from, to] = await Promise.all([source.read('sample'), target.read('sample')]);
    const [a, b] = await Promise.all([oldHash(from!), oldHash(to!)]);
    return a === b;
  },
  'view-to-digest': async () => (await compareObjectContent(source, target, 'sample', bytes.length)).same,
};
const samples = new Map(Object.keys(operations).map((name) => [name, [] as number[]]));

for (let round = 0; round < 35; round++) {
  const names = Object.keys(operations) as (keyof typeof operations)[];
  if (round % 2) names.reverse();
  for (const name of names) {
    const start = performance.now();
    assert.equal(await operations[name](), true);
    if (round >= 5) samples.get(name)!.push(performance.now() - start);
  }
}

console.log(
  JSON.stringify(
    {
      node: process.version,
      bytes: bytes.length,
      rounds: 30,
      avoidedTemporaryCopyBytesPerComparison: bytes.length * 2,
      includes: 'size check, two reads and two SHA-256 hashes; read buffers reused to isolate comparison cost',
      timings: [...samples].map(([mode, values]) => {
        values.sort((a, b) => a - b);
        return { mode, p50Ms: values[15], p95Ms: values[28] };
      }),
    },
    null,
    2,
  ),
);
