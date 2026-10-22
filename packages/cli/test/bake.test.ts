import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadAssetBundleFromDirs } from '../src/commands/assetInput.js';
import { runBakeTopMap } from '../src/commands/bake.js';
import { loadBiomeColors } from '../src/commands/colorInput.js';

test('top-map bake validates strides before scanning regions', async () => {
  await assert.rejects(runBakeTopMap({ world: '/missing/world', sampleStride: 3 }), /sample stride must evenly divide/);
  await assert.rejects(runBakeTopMap({ world: '/missing/world', dim: 'mod:foo/../private' }), /invalid dimension id/);
});

test('an explicit malformed biome file reports its path', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-biomes-'));
  const file = path.join(root, 'biomes.json');
  await fs.writeFile(file, '{broken');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(loadBiomeColors([], file), /invalid JSON in .*biomes\.json/);
});

test('asset scanning finds nested JSON and reports malformed models', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-assets-'));
  const models = path.join(root, 'mod', 'models', 'block');
  await fs.mkdir(models, { recursive: true });
  await fs.writeFile(path.join(models, 'valid.json'), '{}');
  await fs.writeFile(path.join(models, 'broken.json'), '{broken');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await assert.rejects(loadAssetBundleFromDirs([root]), /invalid asset JSON/);
  await fs.rm(path.join(models, 'broken.json'));
  const bundle = await loadAssetBundleFromDirs([root]);
  assert.deepEqual(bundle.models['mod:block/valid'], {});
  assert.equal(bundle.models['mod:block/broken'], undefined);
});

test('top-map bake keeps a malformed existing manifest for repair', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-bake-'));
  const world = path.join(root, 'world');
  const out = path.join(root, 'out');
  const assets = path.join(root, 'assets');
  await Promise.all([fs.mkdir(world), fs.mkdir(out), fs.mkdir(assets)]);
  const manifestPath = path.join(out, 'manifest.json');
  await fs.writeFile(manifestPath, '{broken');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await assert.rejects(runBakeTopMap({ world, out, assetsDir: assets }), /invalid top-map manifest: .*manifest\.json/);
  assert.equal(await fs.readFile(manifestPath, 'utf8'), '{broken');
});

test('topmap uses effective overrides and complete environment dependencies while preserving v6 payloads', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-topmap-complete-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const world = path.join(root, 'world'),
    assets = path.join(root, 'assets'),
    chunks = path.join(world, 'chunks', 'minecraft%3Aoverworld');
  await fs.mkdir(chunks, { recursive: true });
  await fs.mkdir(assets);
  const { createRequire } = await import('node:module');
  const nbt = createRequire(new URL('../../core/package.json', import.meta.url))('prismarine-nbt');
  const chunk = (block: string) =>
    nbt.writeUncompressed({
      type: 'compound',
      name: '',
      value: {
        xPos: { type: 'int', value: 0 },
        zPos: { type: 'int', value: 0 },
        sections: {
          type: 'list',
          value: {
            type: 'compound',
            value: [
              {
                Y: { type: 'byte', value: 0 },
                block_states: {
                  type: 'compound',
                  value: {
                    palette: {
                      type: 'list',
                      value: { type: 'compound', value: [{ Name: { type: 'string', value: block } }] },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    });
  const chunkFile = path.join(chunks, 'c.0.0.nbt');
  await fs.writeFile(chunkFile, chunk('minecraft:stone'));
  const options = { world, assetsDir: assets, sampleStride: 16, colorStride: 16, lightStride: 16, sky: true };
  await runBakeTopMap(options);
  const manifestFile = path.join(world, '.violet-map/top-map/manifest.json');
  const manifest = () => fs.readFile(manifestFile, 'utf8').then(JSON.parse);
  const first = (await manifest()).dimensions['minecraft:overworld'].topMap;
  assert.equal(first.dependency.schemaVersion, 1);
  assert.equal(first.regions.length, 1);
  assert.equal(first.regions[0].artifact.format, 'topmap-msgpack-v6');
  const tile = path.join(world, '.violet-map/top-map/minecraft%3Aoverworld/topmap/r.0.0.msgpack');
  const before = await fs.stat(tile);
  await runBakeTopMap(options);
  assert.equal((await fs.stat(tile)).mtimeMs, before.mtimeMs);
  const { decode } = await import('@msgpack/msgpack');
  assert.equal((decode(await fs.readFile(tile)) as any).schema, 6);
  const { loadServerConfig } = await import('../../server/src/configuration.js');
  const { createServices } = await import('../../server/src/services.js');
  const services = await createServices(
    loadServerConfig({
      env: { DEPLOYMENT_PROFILE: 'public', WORLDS_DIR: root, DATA_DIR: path.join(root, 'data'), ASSETS_DIRS: assets },
      cwd: root,
    }),
  );
  try {
    assert.ok(await services.topMap!.readTopMapTile('world', 'minecraft:overworld', 0, 0));
    const worldReader = services.mounts.worlds!;
    const readRange = worldReader.readRange.bind(worldReader);
    let terrainReads = 0;
    const observed = t.mock.method(worldReader, 'readRange', async (...args: Parameters<typeof readRange>) => {
      if (args[0].endsWith('.nbt') || args[0].endsWith('.mca')) terrainReads++;
      return readRange(...args);
    });
    assert.ok(await services.topMap!.readTopMapTile('world', 'minecraft:overworld', 0, 0));
    assert.equal(terrainReads, 0, 'reliable unchanged terrain revisions reuse dependency digests');
    const savedTile = await fs.readFile(tile);
    await fs.writeFile(tile, new Uint8Array(savedTile.length));
    await assert.rejects(services.topMap!.readTopMapTile('world', 'minecraft:overworld', 0, 0), {
      code: 'RESOURCE_INTEGRITY_FAILED',
    });
    await fs.writeFile(tile, savedTile);
    observed.mock.restore();
    const dimensions = await services.gameData!.readDimensions();
    await services.gameData!.writeDataFile('dimensions.json', {
      ...dimensions,
      'minecraft:overworld': { ...dimensions['minecraft:overworld'], hasSkyLight: false },
    });
    await assert.rejects(services.topMap!.getTopMapManifest('world'), { code: 'TOPMAP_REBAKE_REQUIRED' });
    await services.gameData!.writeDataFile('dimensions.json', dimensions);
    await fs.writeFile(chunkFile, chunk('minecraft:dirt'));
    await assert.rejects(services.topMap!.readTopMapTile('world', 'minecraft:overworld', 0, 0), {
      code: 'TOPMAP_REBAKE_REQUIRED',
    });
    await runBakeTopMap(options);
    const second = (await manifest()).dimensions['minecraft:overworld'].topMap;
    assert.notEqual(second.regions[0].hash, first.regions[0].hash);
    assert.notEqual(second.regions[0].artifact.digest, first.regions[0].artifact.digest);
    await fs.mkdir(path.join(assets, 'test/models'), { recursive: true });
    await fs.writeFile(path.join(assets, 'test/models/example.json'), '{}');
    await assert.rejects(services.topMap!.getTopMapManifest('world'), { code: 'TOPMAP_REBAKE_REQUIRED' });
    await runBakeTopMap(options);
    assert.notEqual(
      (await manifest()).dimensions['minecraft:overworld'].topMap.dependency.environment,
      second.dependency.environment,
    );
  } finally {
    await services.close();
  }
});
