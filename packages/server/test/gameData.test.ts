import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadServerConfig } from '../src/configuration.js';
import { createGameDataService } from '../src/gameData.js';

test('a malformed versioned data file reports its path instead of falling back', async (t) => {
  const config = loadServerConfig();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-map-data-'));
  config.data.dir = dir;
  const { clearGameDataCaches, readBiomes, writeDataFile } = createGameDataService(config);
  t.after(async () => {
    clearGameDataCaches();
    await fs.rm(dir, { recursive: true, force: true });
  });

  await writeDataFile('biomes.json', { expected: { color: 1 } });
  assert.deepEqual(await readBiomes(), { expected: { color: 1 } });

  const versionDir = path.join(dir, 'versions', config.minecraft.version);
  await fs.mkdir(versionDir, { recursive: true });
  await fs.writeFile(path.join(versionDir, 'biomes.json'), '{bad json');
  clearGameDataCaches();
  await assert.rejects(readBiomes(), /invalid JSON in .*biomes\.json/);
});

test('writing a data file invalidates a cached value', async (t) => {
  const config = loadServerConfig();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-map-data-'));
  config.data.dir = dir;
  const { clearGameDataCaches, readBiomes, writeDataFile } = createGameDataService(config);
  t.after(async () => {
    clearGameDataCaches();
    await fs.rm(dir, { recursive: true, force: true });
  });

  await writeDataFile('biomes.json', { first: {} });
  assert.deepEqual(await readBiomes(), { first: {} });
  await writeDataFile('biomes.json', { second: {} });
  assert.deepEqual(await readBiomes(), { second: {} });
});

test('failed local data publication retains the previous complete file and leaves no temporary objects', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-data-atomic-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = loadServerConfig({ env: { DEPLOYMENT_PROFILE: 'public', DATA_DIR: dir }, cwd: dir });
  const data = createGameDataService(config);
  await data.writeDataFile('biomes.json', { old: {} });
  t.mock.method(fs, 'rename', async () => {
    throw new Error('injected publication failure');
  });
  await assert.rejects(data.writeDataFile('biomes.json', { changed: {} }), /injected publication failure/);
  await assert.rejects(data.writeDataFile('biomes.json', undefined), /JSON value/);
  data.clearGameDataCaches();
  assert.deepEqual(await data.readBiomes(), { old: {} });
  assert.deepEqual(await fs.readdir(dir), ['biomes.json']);
});
