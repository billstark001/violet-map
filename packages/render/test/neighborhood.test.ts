import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseChunkColumn } from '@violet-map/core/domain';
import { ChunkNeighborhood } from '../src/mesher/full.js';

test('chunk neighborhoods preserve signed chunk coordinates beyond 32-bit block positions', () => {
  for (const [x, z] of [
    [0, -1],
    [114_514, -114_515],
    [134_217_728, -134_217_729],
    [-2_147_483_648, 2_147_483_647],
  ]) {
    const column = parseChunkColumn({
      xPos: x,
      zPos: z,
      sections: [{ Y: 0, block_states: { palette: [{ Name: 'minecraft:stone' }] } }],
    });
    const neighborhood = new ChunkNeighborhood(x - 1, z - 1);
    neighborhood.set(column);
    for (const offset of [0, 15]) {
      assert.equal(neighborhood.columnAtWorld(x * 16 + offset, z * 16 + offset), column);
      assert.equal(neighborhood.getBlock(x * 16 + offset, 0, z * 16 + offset).name, 'minecraft:stone');
    }
    assert.equal(neighborhood.columnAtWorld(x * 16 - 1, z * 16), null);
    assert.equal(neighborhood.getBlock(x * 16 + 16, 0, z * 16).name, 'minecraft:air');
  }
});
