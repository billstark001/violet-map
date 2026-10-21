import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('a world can discover its first region in a modern dimension directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-world-'));
  const previousWorldsDir = process.env.WORLDS_DIR;
  const previousStorage = process.env.WORLD_STORAGE;
  process.env.WORLDS_DIR = root;
  process.env.WORLD_STORAGE = 'local';
  try {
    const { loadServerConfig } = await import('../src/configuration.js');
    const config = loadServerConfig();
    const { createStorageMounts } = await import('../src/storage.js');
    const { createWorldStore } = await import('../src/worldStore.js');
    const worldStorage = (await createStorageMounts(config)).worlds!;
    const { createTopMapService } = await import('../src/topMap.js');
    const topMap = createTopMapService(worldStorage, config);
    const { getTopMapManifest } = topMap;
    const {
      deleteChunks,
      inspectChunks,
      readChunks,
      invalidateStoredFile,
      listChunkSourceCoverage,
      listWorlds,
      saveChunkNbt,
      saveWorldFile,
    } = createWorldStore(worldStorage, config.minecraft.version);
    const chunks = [{ cx: 0, cz: 0 }];
    assert.equal((await inspectChunks('testworld', 'minecraft:overworld', chunks))[0].missing, true);
    assert.deepEqual(await listWorlds(), []);

    const region = new Uint8Array(3 * 4096);
    new DataView(region.buffer).setUint32(0, (2 << 8) | 1);
    const regionPath = 'testworld/dimensions/minecraft/overworld/region/r.0.0.mca';
    await worldStorage.write(regionPath, region);
    invalidateStoredFile(regionPath);
    const [metadata] = await inspectChunks('testworld', 'minecraft:overworld', chunks);
    assert.equal(metadata.source, 'region');
    assert.match(metadata.sourcePath ?? '', /dimensions\/minecraft\/overworld\/region\/r\.0\.0\.mca$/);
    assert.deepEqual(await listWorlds(), [{ id: 'testworld', dimensions: ['minecraft:overworld'] }]);

    assert.equal(
      (await deleteChunks('testworld', 'minecraft:overworld', [...chunks, ...chunks])).clearedRegionChunks,
      1,
    );
    assert.equal((await inspectChunks('testworld', 'minecraft:overworld', chunks))[0].missing, true);

    assert.equal((await inspectChunks('uploaded', 'minecraft:overworld', chunks))[0].missing, true);
    await saveWorldFile('uploaded', 'dimensions/minecraft/overworld/region/r.0.0.mca', region);
    assert.equal((await inspectChunks('uploaded', 'minecraft:overworld', chunks))[0].source, 'region');
    const coverage = await listChunkSourceCoverage('uploaded', 'minecraft:overworld');
    assert.deepEqual(
      coverage.regions.map(({ x, z }) => ({ x, z })),
      [{ x: 0, z: 0 }],
    );
    assert.equal(Buffer.from(coverage.regions[0].mask, 'base64')[0] & 1, 1);

    const chunkNbt = new Uint8Array([
      10,
      0,
      0, // root compound
      3,
      0,
      4,
      120,
      80,
      111,
      115,
      0,
      0,
      0,
      0, // xPos
      3,
      0,
      4,
      122,
      80,
      111,
      115,
      0,
      0,
      0,
      0, // zPos
      0,
    ]);
    await saveChunkNbt('uploaded', 'minecraft:overworld', chunkNbt);
    const firstHash = ((await readChunks('uploaded', 'minecraft:overworld', [{ cx: 0, cz: 0 }]))[0] ?? null)
      ?.contentDigest;
    assert.match(firstHash!, /^[a-f0-9]{64}$/);
    invalidateStoredFile('uploaded/chunks/minecraft%3Aoverworld/c.0.0.nbt');
    assert.equal(
      ((await readChunks('uploaded', 'minecraft:overworld', [{ cx: 0, cz: 0 }]))[0] ?? null)?.contentDigest,
      firstHash,
    );

    const manifestPath = 'testworld/.violet-map/top-map/manifest.json';
    const encode = (dimensions: Record<string, unknown>) =>
      new TextEncoder().encode(JSON.stringify({ schema: 6, dimensions }));
    await worldStorage.write(manifestPath, encode({}));
    assert.deepEqual((await getTopMapManifest('testworld'))?.dimensions, {});
    await worldStorage.write(
      manifestPath,
      encode({ 'minecraft:overworld': { hasTopMap: true, topMap: { regions: [] } } }),
    );
    invalidateStoredFile(manifestPath);
    await assert.rejects(getTopMapManifest('testworld'), { code: 'TOPMAP_REBAKE_REQUIRED' });

    await saveWorldFile(
      'testworld',
      '.violet-map/top-map/manifest.json',
      encode({ 'minecraft:overworld': { hasTopMap: false } }),
    );
    assert.equal((await getTopMapManifest('testworld'))?.dimensions['minecraft:overworld']?.hasTopMap, false);

    await worldStorage.write(manifestPath, encode({ 'minecraft:overworld': null }));
    invalidateStoredFile(manifestPath);
    await assert.rejects(getTopMapManifest('testworld'), { code: 'TOPMAP_REBAKE_REQUIRED' });
  } finally {
    if (previousWorldsDir === undefined) delete process.env.WORLDS_DIR;
    else process.env.WORLDS_DIR = previousWorldsDir;
    if (previousStorage === undefined) delete process.env.WORLD_STORAGE;
    else process.env.WORLD_STORAGE = previousStorage;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('online world reads retain no second copy of terrain or entity bodies', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-world-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { loadServerConfig } = await import('../src/configuration.js');
  const { LocalStorage } = await import('@violet-map/storage/local');
  const { createWorldStore } = await import('../src/worldStore.js');
  const config = loadServerConfig({ env: { WORLDS_DIR: root }, cwd: root });
  const storage = new LocalStorage(root);
  const store = createWorldStore(storage, config.minecraft.version);
  const region = (payload: Uint8Array) => {
    const bytes = new Uint8Array(3 * 4096);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, (2 << 8) | 1);
    view.setUint32(8192, payload.length + 1);
    bytes[8196] = 3;
    bytes.set(payload, 8197);
    return bytes;
  };
  await storage.write('one/region/r.0.0.mca', region(new Uint8Array([10, 0, 0, 0])));
  await storage.write('one/entities/r.0.0.mca', region(new Uint8Array([10, 0, 0, 1])));
  await storage.write('two/region/r.0.0.mca', region(new Uint8Array([10, 0, 0, 0])));
  const first = (await store.readChunks('one', 'minecraft:overworld', [{ cx: 0, cz: 0 }]))[0] ?? null;
  const second = (await store.readChunks('one', 'minecraft:overworld', [{ cx: 0, cz: 0 }]))[0] ?? null;
  assert.ok(first?.entities);
  assert.deepEqual(first.entities, new Uint8Array([10, 0, 0, 1]));
  assert.deepEqual(second?.data, first.data);
  assert.deepEqual(second?.entities, first.entities);
  assert.equal(second?.contentDigest, first.contentDigest);
  const other = (await store.readChunks('two', 'minecraft:overworld', [{ cx: 0, cz: 0 }]))[0] ?? null;
  assert.ok(other, 'second world chunk must be readable');
  assert.equal(other.entities, undefined, 'terrain regions must never be treated as entity sidecars');
  assert.equal(store.cacheStats().regions, 0);
  assert.equal(store.cacheStats().chunkBytes, 0);
  await store.deleteWorld('one');
  assert.equal(store.cacheStats().regions, 0);
  assert.equal(store.cacheStats().regionHeaders, 0);
  assert.equal(store.cacheStats().chunks, 0);
  assert.equal(store.cacheStats().chunkBytes, 0);
});

test('region-only batches avoid per-chunk negative HEADs and still discover newly written overrides', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-override-probes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { LocalStorage } = await import('@violet-map/storage/local');
  const { CachedStorage } = await import('@violet-map/storage');
  const { loadServerConfig } = await import('../src/configuration.js');
  const { createWorldStore } = await import('../src/worldStore.js');
  let probes = 0;
  class CountingStorage extends LocalStorage {
    override async stat(file: string) {
      if (file.includes('/chunks/')) probes++;
      return super.stat(file);
    }
  }
  const storage = new CachedStorage(new CountingStorage(root), { listTtlMs: 60_000 });
  const config = loadServerConfig({ env: { DEPLOYMENT_PROFILE: 'public' }, cwd: root });
  const store = createWorldStore(storage, config.minecraft.version);
  const region = new Uint8Array(3 * 4096);
  const view = new DataView(region.buffer);
  for (let index = 0; index < 128; index++) view.setUint32(index * 4, (2 << 8) | 1);
  await storage.write('world/region/r.0.0.mca', region);
  const chunks = Array.from({ length: 128 }, (_, index) => ({ cx: index % 32, cz: Math.floor(index / 32) }));
  assert.ok(
    (await store.inspectChunks('world', 'minecraft:overworld', chunks)).every((meta) => meta.source === 'region'),
  );
  assert.equal(probes, 0);
  await storage.write('world/chunks/minecraft%3Aoverworld/c.0.0.nbt', new Uint8Array([10, 0, 0, 0]));
  assert.equal(
    ((await store.inspectChunks('world', 'minecraft:overworld', [{ cx: 0, cz: 0 }]))[0] ?? null).source,
    'chunk',
  );
  assert.equal(probes, 1, 'a cached empty directory listing must be invalidated by the write');
  await storage.delete('world/chunks/minecraft%3Aoverworld/c.0.0.nbt');
  assert.equal(
    ((await store.inspectChunks('world', 'minecraft:overworld', [{ cx: 0, cz: 0 }]))[0] ?? null).source,
    'region',
  );
});
