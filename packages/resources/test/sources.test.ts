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

test('source revisions invalidate cached terrain/entities without becoming content digests', async (t) => {
  const { storage, source } = await sourceFixture(t, 64 * 1024);
  const stat = storage.stat.bind(storage);
  let revision = 1;
  storage.stat = async (key) => {
    const info = await stat(key);
    return info ? { ...info, modifiedAt: revision } : null;
  };
  const terrain = new Uint8Array([10, 0, 0, 0]),
    entities = new Uint8Array([10, 0, 0, 1]);
  await storage.write('world/region/r.0.0.mca', savedRegion(terrain));
  await storage.write('world/entities/r.0.0.mca', savedRegion(entities));
  const read = async () => (await source.readChunks('world', 'minecraft:overworld', [{ cx: 0, cz: 0 }]))[0]!;
  const first = await read(),
    cached = await read();
  assert.equal(cached.data, first.data);
  assert.equal(cached.entities, first.entities);
  assert.equal(first.terrainDigest, sha256(terrain));
  assert.equal(first.entityDigest, sha256(entities));
  revision++;
  const same = await read();
  assert.notEqual(same.sourceRevision, first.sourceRevision);
  assert.equal(same.contentDigest, first.contentDigest);
  await storage.write('world/entities/r.0.0.mca', savedRegion(new Uint8Array([10, 0, 0, 2])));
  revision++;
  const changed = await read();
  assert.equal(changed.terrainDigest, first.terrainDigest);
  assert.notEqual(changed.entityDigest, first.entityDigest);
  assert.notEqual(changed.contentDigest, first.contentDigest);
});

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
  await assert.rejects(
    source.readChunks('world', 'minecraft:overworld', [{ cx: 0, cz: 0 }]).then((rows) => rows[0] ?? null),
    {
      code: 'RESOURCE_INTEGRITY_FAILED',
    },
  );
  assert.equal((await source.readChunks('world', 'minecraft:overworld', [{ cx: 1, cz: 0 }]))[0] ?? null, null);
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
      assert.equal((await source.readChunks('world', 'minecraft:overworld', [{ cx: 0, cz: 0 }]))[0] ?? null, null);
      const saved = (await source.readChunks('world', 'minecraft:overworld', [{ cx: 32, cz: 0 }]))[0] ?? null;
      assert.deepEqual(saved?.data, terrainNbt);
      assert.equal(saved?.entities, undefined);
      assert.equal((await storage.stat(empty))?.size, 0);
      assert.equal((await storage.stat(entities))?.size, 0);

      await storage.replace(entities, savedRegion(entityNbt));
      source.invalidateStoredFile(entities);
      assert.deepEqual(
        ((await source.readChunks('world', 'minecraft:overworld', [{ cx: 32, cz: 0 }]))[0] ?? null)?.entities,
        entityNbt,
      );
      await storage.replace(empty, savedRegion(terrainNbt));
      source.invalidateStoredFile(empty);
      assert.deepEqual(
        ((await source.readChunks('world', 'minecraft:overworld', [{ cx: 0, cz: 0 }]))[0] ?? null)?.data,
        terrainNbt,
      );
      await storage.replace(entities, new Uint8Array(100));
      source.invalidateStoredFile(entities);
      await assert.rejects(
        source.readChunks('world', 'minecraft:overworld', [{ cx: 32, cz: 0 }]).then((rows) => rows[0] ?? null),
        {
          code: 'RESOURCE_INTEGRITY_FAILED',
        },
      );
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
        const read = storage.readRange.bind(storage);
        let headerRead = false,
          recordRead = false,
          truncated = false;
        t.mock.method(storage, 'readRange', async (filePath: string, start: number, length: number) => {
          if (filePath === key && start === 0 && phase === 'header' && !truncated) {
            truncated = true;
            await storage.replace(key, new Uint8Array());
          }
          const bytes = await read(filePath, start, length);
          if (filePath === key) {
            if (start === 0) headerRead = true;
            else if (start >= 8192) recordRead = true;
          }
          return bytes;
        });
        t.mock.method(storage, 'stat', async (filePath: string) => {
          if (
            filePath === key &&
            !truncated &&
            ((phase === 'before-body' && headerRead) || (phase === 'body-restat' && recordRead))
          ) {
            truncated = true;
            await storage.replace(filePath, new Uint8Array());
          }
          return stat(filePath);
        });
        await assert.rejects(
          source.readChunks('world', 'minecraft:overworld', [{ cx: 0, cz: 0 }]).then((rows) => rows[0] ?? null),
          {
            code: 'SOURCE_SNAPSHOT_CHANGED',
          },
        );
      });
    }
  }
});

test('range reads bound a sparse large region to its header and requested sectors', async (t) => {
  const { source, storage } = await sourceFixture(t);
  const region = new Uint8Array(16 * 1024 ** 2);
  region.set(savedRegion());
  const view = new DataView(region.buffer);
  view.setUint32(4, (3 << 8) | 1);
  view.setUint32(12288, 5);
  region[12292] = 3;
  region.set(new Uint8Array([10, 0, 0, 1]), 12293);
  await storage.write('world/region/r.0.0.mca', region);
  const reads: { start: number; length: number }[] = [];
  const read = storage.readRange.bind(storage);
  t.mock.method(storage, 'readRange', async (key: string, start: number, length: number) => {
    reads.push({ start, length });
    return read(key, start, length);
  });
  const rows = await source.readChunks('world', 'minecraft:overworld', [
    { cx: 0, cz: 0 },
    { cx: 1, cz: 0 },
  ]);
  assert.deepEqual(
    rows.map((r) => [...r!.data]),
    [
      [10, 0, 0, 0],
      [10, 0, 0, 1],
    ],
  );
  assert.ok(
    reads.every((r) => r.length <= 4096),
    'no complete MCA is buffered',
  );
  assert.equal(reads.filter((r) => r.start >= 8192).length, 2);
  assert.ok(reads.reduce((sum, r) => sum + r.length, 0) <= 4 * 4096);
});

test('an early background observation does not block fresh reads but stale reads wait and see invalidation', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const coordinator = new InvalidationCoordinator();
  let calls = 0;
  const gate = deferred();
  const source = new BoundedSource(
    coordinator,
    async () => {
      if (++calls > 1) await gate.promise;
      return sha256(new Uint8Array([calls]));
    },
    5000,
  );
  await source.validate();
  t.mock.timers.tick(4000);
  const background = source.validate(true);
  await source.validate();
  assert.equal(coordinator.generation, 0);
  t.mock.timers.tick(1000);
  let finished = false;
  const stale = source.validate().then(() => {
    finished = true;
  });
  await Promise.resolve();
  assert.equal(finished, false);
  gate.release();
  await Promise.all([background, stale]);
  assert.equal(coordinator.generation, 1);
  assert.equal(calls, 2);
});

test('layout discovery stops streaming after one region instead of enumerating the dimension', async (t) => {
  const { source, storage } = await sourceFixture(t);
  await storage.write('world/region/r.0.0.mca', savedRegion());
  await storage.write('world/region/r.1.0.mca', savedRegion());
  t.mock.method(storage, 'list', async () => {
    throw Error('layout discovery must not enumerate a whole local dimension');
  });
  const scan = storage.scan.bind(storage);
  t.mock.method(storage, 'scan', async function* (prefix = '') {
    for await (const file of scan(prefix)) {
      yield file;
      throw Error('layout discovery requested another region');
    }
  });
  const rows = await source.readChunks('world', 'minecraft:overworld', [{ cx: 0, cz: 0 }]);
  assert.deepEqual(rows[0]?.data, new Uint8Array([10, 0, 0, 0]));
});
