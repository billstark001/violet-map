import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDimensionId } from '@violet-map/core';

test('dimension IDs allow custom paths but reject traversal components', () => {
  assert.equal(isDimensionId('minecraft:overworld'), true);
  assert.equal(isDimensionId('mod:sky/islands'), true);
  assert.equal(isDimensionId('overworld'), true);
  for (const value of ['mod:../private', 'mod:foo/../private', 'mod:foo//bar', 'mod:', 'mod:a:b', '']) {
    assert.equal(isDimensionId(value), false, value);
  }
});
