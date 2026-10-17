import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getRegionChunkRecord, type RegionChunkRecord } from '../../../packages/core/src/region.js';

export interface HardRegionSample extends RegionChunkRecord {
  region: Uint8Array;
  x: number;
  z: number;
}

/** Read only explicitly selected regions and retain their eight largest records. */
export async function loadHardRegionSamples(paths: string[]): Promise<HardRegionSample[]> {
  assert.ok(paths.length > 0 && paths.length <= 2, 'provide one or two representative .mca paths');
  const samples: HardRegionSample[] = [];
  for (const path of paths) {
    const region = await readFile(resolve(path));
    const records: HardRegionSample[] = [];
    for (let z = 0; z < 32; z++)
      for (let x = 0; x < 32; x++) {
        const record = getRegionChunkRecord(region, x, z);
        if (record) records.push({ region, x, z, ...record });
      }
    samples.push(...records.toSorted((a, b) => b.payload.byteLength - a.payload.byteLength).slice(0, 8));
  }
  assert.ok(samples.length > 0, 'regions contain no supported chunks');
  return samples;
}
