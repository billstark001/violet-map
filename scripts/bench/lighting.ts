import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { getRegionChunk } from '../../packages/core/src/region.js';
import { parseNbt } from '../../packages/core/src/nbt.js';
import { parseChunkColumn } from '../../packages/core/src/world.js';
import { createBlockInfoMap, applyBlockInfoOverrides } from '../../packages/core/src/assets.js';
import { computeColumnLight } from '../../packages/render/src/light.js';
import { loadHardRegionSamples } from './helpers/region-samples.js';

const require = createRequire(new URL('../../packages/server/package.json', import.meta.url));
const info = createBlockInfoMap(require('minecraft-data')('1.21.4').blocksArray);

applyBlockInfoOverrides(
  info,
  JSON.parse(
    await readFile(new URL('../../packages/core/data-defaults/block-overrides.json', import.meta.url), 'utf8'),
  ),
);

const samples = await loadHardRegionSamples(process.argv.slice(2));
const roots = samples.map((sample) => parseNbt(getRegionChunk(sample.region, sample.x, sample.z)!));
const fallback = { filter: 15, emit: 0 };
const reports = [];

for (const mode of ['block', 'sky', 'both']) {
  const timings: number[] = [];
  let expected = '';
  for (let round = 0; round < 12; round++) {
    const columns = roots.map(parseChunkColumn);
    const start = performance.now();
    for (const column of columns)
      computeColumnLight(column, (name) => info[name] ?? fallback, true, {
        writeBlock: mode !== 'sky',
        writeSky: mode !== 'block',
      });
    if (round >= 2) timings.push(performance.now() - start);
    const hash = createHash('sha256');
    for (const column of columns)
      for (const section of column.sections.values()) {
        if (section.blockLight) hash.update(section.blockLight);
        if (section.skyLight) hash.update(section.skyLight);
      }
    const digest = hash.digest('hex');
    if (expected) assert.equal(digest, expected);
    else expected = digest;
  }
  timings.sort((a, b) => a - b);
  reports.push({ mode, p50BatchMs: timings[5], p95BatchMs: timings[9], digest: expected });
}

console.log(
  JSON.stringify(
    {
      node: process.version,
      chunks: roots.length,
      measuredRounds: 10,
      includes:
        'forced column lighting using 1.21.4 metadata plus defaults; parsing, registry loading and result hashing excluded',
      reports,
    },
    null,
    2,
  ),
);
