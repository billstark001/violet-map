import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGameDataSource } from '../src/gameData.js';

test('explicit 26.1 metadata contains new blocks and applies overrides through the shared source', async () => {
  const source = createGameDataSource({
    dataVersion: '26.1',
    readOverrides: async () => ({ 'minecraft:golden_dandelion': { emit: 3 } }),
  });
  const blocks = await source.buildBlockInfo();
  assert.ok(blocks['minecraft:copper_chest']);
  assert.equal(blocks['minecraft:golden_dandelion'].emit, 3);
  await assert.rejects(
    createGameDataSource({
      dataVersion: 'not-a-version',
      readOverrides: async () => ({}),
    }).buildBlockInfo(),
    /unsupported minecraft-data version/,
  );
});
