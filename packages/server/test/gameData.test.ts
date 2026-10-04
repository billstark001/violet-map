import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { clearGameDataCaches, readBiomes, writeDataFile } from '../src/gameData.js';

test('a malformed versioned data file reports its path instead of falling back', async (t) => {
  const oldDataDir = config.dataDir;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-map-data-'));
  config.dataDir = dir;
  clearGameDataCaches();
  t.after(async () => {
    config.dataDir = oldDataDir;
    clearGameDataCaches();
    await fs.rm(dir, { recursive: true, force: true });
  });

  await writeDataFile('biomes.json', { expected: { color: 1 } });
  assert.deepEqual(await readBiomes(), { expected: { color: 1 } });

  const versionDir = path.join(dir, 'versions', config.mcVersion);
  await fs.mkdir(versionDir, { recursive: true });
  await fs.writeFile(path.join(versionDir, 'biomes.json'), '{bad json');
  clearGameDataCaches();
  await assert.rejects(readBiomes(), /invalid JSON in .*biomes\.json/);
});

test('writing a data file invalidates a cached value', async (t) => {
  const oldDataDir = config.dataDir;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-map-data-'));
  config.dataDir = dir;
  clearGameDataCaches();
  t.after(async () => {
    config.dataDir = oldDataDir;
    clearGameDataCaches();
    await fs.rm(dir, { recursive: true, force: true });
  });

  await writeDataFile('biomes.json', { first: {} });
  assert.deepEqual(await readBiomes(), { first: {} });
  await writeDataFile('biomes.json', { second: {} });
  assert.deepEqual(await readBiomes(), { second: {} });
});
