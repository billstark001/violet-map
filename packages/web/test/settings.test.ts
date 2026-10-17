import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSettingsStore, SETTINGS_STORAGE_KEY } from '../src/state/settings.js';

function memory(initial: string) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

test('settings tolerate malformed storage and clamp invalid numeric and enum state', () => {
  for (const raw of ['null', '[]', '42', '{bad']) {
    const store = createSettingsStore(
      '?viewDistance=999&lodDistance=-1&fastMoveMultiplier=Infinity&viewMode=unknown',
      memory(raw),
    );
    assert.equal(store.state.value.viewDistance, 32);
    assert.equal(store.state.value.lodDistance, 0);
    assert.equal(store.state.value.fastMoveMultiplier, 4);
    assert.equal(store.state.value.viewMode, 'perspective');
    store.persist(true);
  }
  const unavailable = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };
  createSettingsStore('', unavailable).persist(false);
});

test('query settings remain local and clip edits restore independently across dimension changes', () => {
  const storage = memory(
    JSON.stringify({
      world: 'saved',
      viewDistance: 12,
      topClipRanges: { 'minecraft:the_nether': { minY: -32, maxY: 64 } },
    }),
  );
  const store = createSettingsStore('?world=shared&viewDistance=4', storage);
  assert.equal(store.state.value.world, 'shared');
  store.update({ viewDistance: 8, topClipRange: { minY: 32, maxY: 160 } });
  store.persist(true);
  assert.equal(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY)).viewDistance, 12);
  assert.equal(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY)).world, 'saved');
  store.update({ dimension: 'minecraft:the_nether' });
  assert.deepEqual(store.state.value.topClipRange, { minY: -32, maxY: 64 });
  store.persist(true);
  store.update({ dimension: 'minecraft:overworld' });
  assert.deepEqual(store.state.value.topClipRange, { minY: 32, maxY: 160 });
  assert.deepEqual(
    createSettingsStore('?dimension=minecraft:overworld&topClipMaxY=80', storage).state.value.topClipRange,
    { minY: 16, maxY: 80 },
  );
});
