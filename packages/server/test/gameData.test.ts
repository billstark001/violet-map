import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadServerConfig } from '../src/configuration.js';
import { createGameDataService } from '../src/gameData.js';
import { LocalStorage } from '@violet-map/storage/local';

test('game data rejects oversized selected input before reading a body and rejects invalid UTF-8', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-bounded-data-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = loadServerConfig({ env: { DEPLOYMENT_PROFILE: 'public', DATA_DIR: dir }, cwd: dir });
  const overrides = new LocalStorage(dir);
  let bodyReads = 0;
  const range = overrides.readRange.bind(overrides);
  overrides.readRange = async (...args) => {
    bodyReads++;
    return range(...args);
  };
  const key = `versions/${config.minecraft.version}/biomes.json`;
  await overrides.replace(key, new Uint8Array(8 * 1024 ** 2 + 1));
  const data = createGameDataService(config, overrides);
  await assert.rejects(data.readBiomes(), { code: 'RESOURCE_BUSY' });
  assert.equal(bodyReads, 0);
  await overrides.replace(key, new Uint8Array([0x22, 0xff, 0x22]));
  await assert.rejects(data.readBiomes(), /invalid JSON in versions/);
  await overrides.replace(key, new TextEncoder().encode('{"first":{}}'));
  const first = await data.revision();
  await overrides.replace(key, new TextEncoder().encode('{"other":{}}'));
  assert.notEqual(await data.revision(), first);
  assert.deepEqual(await data.readBiomes(), { other: {} });
});

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
