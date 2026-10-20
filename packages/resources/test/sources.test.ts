import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256 } from '@violet-map/storage';
import { BoundedSource, InvalidationCoordinator, SnapshotGate, sourceSnapshot } from '../src/index.js';
import { createWorldSource } from '../src/sources/worldChunks.js';
import { LocalStorage } from '@violet-map/storage/local';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

function savedRegion(data = new Uint8Array([10, 0, 0, 0])) {
  const bytes = new Uint8Array(12288);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, (2 << 8) | 1);
  view.setUint32(8192, data.length + 1);
  bytes[8196] = 3;
  bytes.set(data, 8197);
  return bytes;
}

async function sourceFixture(t: { after(fn: () => Promise<unknown>): void }, regionBytes = 0) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-region-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = new LocalStorage(root);
  const source = createWorldSource(storage, {
    cache: { regionBytes, chunkNbtBytes: regionBytes, worldListMs: 0 },
  });
  return { storage, source };
}

test('bounded observations coalesce and detect changed bytes with unchanged weak file metadata', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const coordinator = new InvalidationCoordinator();
  let bytes = new Uint8Array([1]);
  let observations = 0;
  const source = new BoundedSource(
    coordinator,
    async () => {
      observations++;
      return sha256(bytes);
    },
    5000,
  );
  await Promise.all(Array.from({ length: 100 }, () => source.validate()));
  assert.equal(observations, 1);
  bytes = new Uint8Array([2]);
  t.mock.timers.tick(4999);
  await source.validate();
  assert.equal(coordinator.generation, 0);
  t.mock.timers.tick(1);
  await source.validate();
  assert.equal(coordinator.generation, 1);
  assert.equal(source.sourceObservedAt, 15000);
  assert.throws(() => new BoundedSource(coordinator, async () => '', 5001));
});

test('a fixed snapshot requires its explicit freeze and rejects source invalidation', async () => {
  const coordinator = new InvalidationCoordinator();
  let frozen = true;
  const snapshot = sourceSnapshot({ read: async () => new Uint8Array([1]) } as never, coordinator, 'archive-A', {
    async validate() {
      if (!frozen) throw new Error('freeze lost');
    },
  });
  assert.deepEqual(await snapshot.read('chunk'), new Uint8Array([1]));
  frozen = false;
  await assert.rejects(snapshot.validate(), /freeze lost/);
  frozen = true;
  coordinator.invalidate();
  await assert.rejects(snapshot.read('chunk'), { code: 'SOURCE_SNAPSHOT_CHANGED' });
});

test('snapshot barrier excludes source commits, bounds waiting work and rejects stale nested tokens', async () => {
  const gate = new SnapshotGate(1);
  const hold = deferred();
  let token: unknown;
  const reading = gate.read(async (current) => {
    token = current;
    await hold.promise;
  });
  const events: string[] = [];
  const writing = gate.write(async () => {
    events.push('write');
  });
  await assert.rejects(
    gate.read(async () => {}),
    { code: 'RESOURCE_BUSY' },
  );
  assert.deepEqual(events, []);
  hold.release();
  await Promise.all([reading, writing]);
  assert.deepEqual(events, ['write']);
  await assert.rejects(
    gate.read(async () => {}, token as never),
    { code: 'SOURCE_SNAPSHOT_CHANGED' },
  );
});

test('declared but corrupt source regions and chunks never become logical missing resources', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-corrupt-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const storage = new LocalStorage(root);
  const source = createWorldSource(storage, {
    cache: { regionBytes: 0, chunkNbtBytes: 0, worldListMs: 0, metadataEntries: 0 },
  });
  const key = 'world/region/r.0.0.mca';
  for (const size of [1, 100, 4096, 8191]) {
    await storage.replace(key, new Uint8Array(size));
    await assert.rejects(source.listChunkSourceCoverage('world', 'minecraft:overworld'), {
      code: 'RESOURCE_INTEGRITY_FAILED',
    });
    await assert.rejects(source.readRegionFile(key), { code: 'RESOURCE_INTEGRITY_FAILED' });
  }
  const region = new Uint8Array(12288);
  const view = new DataView(region.buffer);
  view.setUint32(0, (2 << 8) | 1);
  view.setUint32(8192, 5000);
  region[8196] = 3;
  await storage.replace(key, region);
  await assert.rejects(source.getChunkNbtWithMeta('world', 'minecraft:overworld', 0, 0), {
    code: 'RESOURCE_INTEGRITY_FAILED',
  });
  assert.equal(await source.getChunkNbtWithMeta('world', 'minecraft:overworld', 1, 0), null);
});

test('zero-byte terrain and entity regions are empty, preserve saved neighbors and can receive chunks later', async (t) => {
  for (const regionBytes of [0, 16384]) {
    await t.test(`retention ${regionBytes}`, async (t) => {
      const { storage, source } = await sourceFixture(t, regionBytes);
      const empty = 'world/region/r.0.0.mca';
      const neighbor = 'world/region/r.1.0.mca';
      const entities = 'world/entities/r.1.0.mca';
      const terrainNbt = new Uint8Array([10, 0, 0, 0]);
      const entityNbt = new Uint8Array([10, 0, 0, 1, 0, 1, 97, 1, 0]);
      await storage.replace(empty, new Uint8Array());
      await storage.replace(neighbor, savedRegion(terrainNbt));
      await storage.replace(entities, new Uint8Array());

      const coverage = await source.listChunkSourceCoverage('world', 'minecraft:overworld');
      assert.deepEqual(await source.listRegions('world', 'minecraft:overworld'), [{ x: 1, z: 0 }]);
      assert.deepEqual(
        coverage.regions.map(({ x, z }) => ({ x, z })),
        [{ x: 1, z: 0 }],
      );
      const masks = coverage.regions.map((region) => Buffer.from(region.mask, 'base64'));
      assert.equal(
        masks.reduce((sum, mask) => sum + [...mask].filter((byte) => byte !== 0).length, 0),
        1,
      );
      assert.equal(await source.readRegionFile(empty), null);
      assert.equal(await source.readRegionFile(entities), null);
      assert.equal(await source.getChunkNbtWithMeta('world', 'minecraft:overworld', 0, 0), null);
      const saved = await source.getChunkNbtWithMeta('world', 'minecraft:overworld', 32, 0);
      assert.deepEqual(saved?.data, terrainNbt);
      assert.equal(saved?.entities, undefined);
      assert.equal((await storage.stat(empty))?.size, 0);
      assert.equal((await storage.stat(entities))?.size, 0);

      await storage.replace(entities, savedRegion(entityNbt));
      source.invalidateStoredFile(entities);
      assert.deepEqual((await source.getChunkNbtWithMeta('world', 'minecraft:overworld', 32, 0))?.entities, entityNbt);
      await storage.replace(empty, savedRegion(terrainNbt));
      source.invalidateStoredFile(empty);
      assert.deepEqual((await source.getChunkNbtWithMeta('world', 'minecraft:overworld', 0, 0))?.data, terrainNbt);
      await storage.replace(entities, new Uint8Array(100));
      source.invalidateStoredFile(entities);
      await assert.rejects(source.getChunkNbtWithMeta('world', 'minecraft:overworld', 32, 0), {
        code: 'RESOURCE_INTEGRITY_FAILED',
      });
    });
  }
});

test('declared terrain and entity regions becoming empty during reads remain source-change errors', async (t) => {
  for (const directory of ['region', 'entities']) {
    for (const phase of ['header', 'before-body', 'body-restat']) {
      await t.test(`${directory}: ${phase}`, async (t) => {
        const { storage, source } = await sourceFixture(t);
        const terrain = 'world/region/r.0.0.mca';
        const key = `world/${directory}/r.0.0.mca`;
        await storage.replace(terrain, savedRegion());
        if (key !== terrain) await storage.replace(key, savedRegion());
        const stat = storage.stat.bind(storage);
        let observations = 0;
        t.mock.method(storage, 'stat', async (filePath: string) => {
          if (filePath === key) {
            observations++;
            const truncateAt = phase === 'header' ? 1 : phase === 'before-body' ? 2 : 3;
            if (observations === truncateAt) {
              const before = await stat(filePath);
              await storage.replace(filePath, new Uint8Array());
              if (phase === 'header') return before;
            }
          }
          return stat(filePath);
        });
        await assert.rejects(source.getChunkNbtWithMeta('world', 'minecraft:overworld', 0, 0), {
          code: 'SOURCE_SNAPSHOT_CHANGED',
        });
      });
    }
  }
});
