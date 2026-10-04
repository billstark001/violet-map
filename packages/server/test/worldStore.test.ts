import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('a world can discover its first region in a modern dimension directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-world-'));
  const previousWorldsDir = process.env.WORLDS_DIR;
  const previousStorage = process.env.WORLD_STORAGE;
  process.env.WORLDS_DIR = root;
  process.env.WORLD_STORAGE = 'local';
  try {
    const [
      { worldStorage },
      {
        deleteChunks,
        getChunkMetadataBatch,
        getChunkNbtWithMeta,
        invalidateStoredFile,
        listChunkSourceCoverage,
        listWorlds,
        saveChunkNbt,
        saveWorldFile,
      },
      { getTopMapManifest, getWorldCapabilities },
    ] = await Promise.all([import('../src/storage.js'), import('../src/worldStore.js'), import('../src/topMap.js')]);
    const chunks = [{ cx: 0, cz: 0 }];
    assert.equal((await getChunkMetadataBatch('testworld', 'minecraft:overworld', chunks))[0].missing, true);
    assert.deepEqual(await listWorlds(), []);

    const region = new Uint8Array(3 * 4096);
    new DataView(region.buffer).setUint32(0, (2 << 8) | 1);
    const regionPath = 'testworld/dimensions/minecraft/overworld/region/r.0.0.mca';
    await worldStorage.write(regionPath, region);
    invalidateStoredFile(regionPath);
    const [metadata] = await getChunkMetadataBatch('testworld', 'minecraft:overworld', chunks);
    assert.equal(metadata.source, 'region');
    assert.match(metadata.sourcePath ?? '', /dimensions\/minecraft\/overworld\/region\/r\.0\.0\.mca$/);
    assert.deepEqual(await listWorlds(), [{ id: 'testworld', dimensions: ['minecraft:overworld'] }]);

    assert.equal(
      (await deleteChunks('testworld', 'minecraft:overworld', [...chunks, ...chunks])).clearedRegionChunks,
      1,
    );
    assert.equal((await getChunkMetadataBatch('testworld', 'minecraft:overworld', chunks))[0].missing, true);

    assert.equal((await getChunkMetadataBatch('uploaded', 'minecraft:overworld', chunks))[0].missing, true);
    await saveWorldFile('uploaded', 'dimensions/minecraft/overworld/region/r.0.0.mca', region);
    assert.equal((await getChunkMetadataBatch('uploaded', 'minecraft:overworld', chunks))[0].source, 'region');
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
    const firstHash = (await getChunkNbtWithMeta('uploaded', 'minecraft:overworld', 0, 0))?.nbtHash;
    assert.equal(
      firstHash,
      createHash('sha256')
        .update(chunkNbt)
        .update(new Uint8Array([0]))
        .digest('hex'),
    );
    invalidateStoredFile('uploaded/chunks/minecraft%3Aoverworld/c.0.0.nbt');
    assert.equal((await getChunkNbtWithMeta('uploaded', 'minecraft:overworld', 0, 0))?.nbtHash, firstHash);

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
    assert.equal((await getTopMapManifest('testworld'))?.dimensions['minecraft:overworld']?.hasTopMap, true);

    await saveWorldFile(
      'testworld',
      '.violet-map/top-map/manifest.json',
      encode({ 'minecraft:overworld': { hasTopMap: false } }),
    );
    assert.equal((await getTopMapManifest('testworld'))?.dimensions['minecraft:overworld']?.hasTopMap, false);

    await worldStorage.write(manifestPath, encode({ 'minecraft:overworld': null }));
    invalidateStoredFile(manifestPath);
    assert.equal(await getTopMapManifest('testworld'), null);
    assert.equal((await getWorldCapabilities('testworld')).hasTopMap, false);
  } finally {
    if (previousWorldsDir === undefined) delete process.env.WORLDS_DIR;
    else process.env.WORLDS_DIR = previousWorldsDir;
    if (previousStorage === undefined) delete process.env.WORLD_STORAGE;
    else process.env.WORLD_STORAGE = previousStorage;
    await fs.rm(root, { recursive: true, force: true });
  }
});
