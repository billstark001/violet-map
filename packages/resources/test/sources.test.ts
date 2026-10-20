import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256 } from '@violet-map/storage';
import { BoundedSource, InvalidationCoordinator, SnapshotGate, sourceSnapshot } from '../src/index.js';

const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

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
