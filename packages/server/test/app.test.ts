import { LocalStorage } from '@violet-map/storage/local';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadServerConfig } from '../src/configuration.js';
import { createGameDataService } from '../src/gameData.js';
import { createServices } from '../src/services.js';
import { createTopMapService } from '../src/topMap.js';
import { createWorldStore } from '../src/worldStore.js';

test('service instances keep world, manifest, and game data caches independent', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-instances-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const make = (name: string) => {
    const config = loadServerConfig({
      env: { DATA_DIR: path.join(root, name), DEPLOYMENT_PROFILE: 'public' },
      cwd: root,
    });
    const storage = new LocalStorage(path.join(root, name, 'worlds'));
    const data = createGameDataService(config);
    const topMap = createTopMapService(storage, config, data);
    return { storage, data, topMap, worlds: createWorldStore(storage, config.minecraft.version) };
  };
  const first = make('first'),
    second = make('second');
  await first.data.writeDataFile('biomes.json', { first: {} });
  await second.data.writeDataFile('biomes.json', { second: {} });
  assert.deepEqual(await first.data.readBiomes(), { first: {} });
  assert.deepEqual(await second.data.readBiomes(), { second: {} });
  await first.worlds.createWorld('first');
  await second.worlds.createWorld('second');
  assert.equal((await first.worlds.listWorlds())[0].id, 'first');
  assert.equal((await second.worlds.listWorlds())[0].id, 'second');
  const manifest = (hasTopMap: boolean) =>
    new TextEncoder().encode(
      JSON.stringify({
        schema: 6,
        dimensions: { 'minecraft:overworld': { hasTopMap, ...(hasTopMap ? { topMap: { regions: [] } } : {}) } },
      }),
    );
  await first.storage.write('same/.violet-map/top-map/manifest.json', manifest(true));
  await second.storage.write('same/.violet-map/top-map/manifest.json', manifest(false));
  await assert.rejects(first.topMap.getTopMapManifest('same'), { code: 'TOPMAP_REBAKE_REQUIRED' });
  assert.equal((await second.topMap.getTopMapManifest('same'))!.dimensions['minecraft:overworld'].hasTopMap, false);
});

// Imports above must work even without any database or HTTP initialization.
test('application and service factory imports expose functions without starting services', () => {
  assert.equal(typeof createApp, 'function');
  assert.equal(typeof createServices, 'function');
});
