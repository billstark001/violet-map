import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dimensionRegionPaths, isDimensionId, VANILLA_DIMENSION_IDS } from '../src/dimensionId.js';

test('dimension IDs reject path traversal in both namespace and resource segments', () => {
  for (const value of ['.:a', '..:a', 'x:..', 'x:a/../b', 'x:/a', 'x:a//b', 'x:a%', 'x:a:b', '', null])
    assert.equal(isDimensionId(value), false, String(value));
  for (const value of ['overworld', 'minecraft:overworld', 'custom:region/inner', '__proto__', 'constructor']) {
    assert.equal(isDimensionId(value), true);
    assert.ok(dimensionRegionPaths(value).every((directory) => !directory.split('/').includes('..')));
  }
  assert.throws(() => dimensionRegionPaths('../invalid'), /dimension/);
});

test('terrain lookup preserves vanilla precedence and shares modern custom paths', () => {
  assert.deepEqual(dimensionRegionPaths('minecraft:overworld'), ['region', 'dimensions/minecraft/overworld/region']);
  assert.deepEqual(dimensionRegionPaths('minecraft:the_nether'), [
    'DIM-1/region',
    'dimensions/minecraft/the_nether/region',
  ]);
  assert.deepEqual(dimensionRegionPaths('minecraft:the_end'), ['DIM1/region', 'dimensions/minecraft/the_end/region']);
  assert.deepEqual(dimensionRegionPaths('custom:region/inner'), ['dimensions/custom/region/inner/region']);
  assert.deepEqual(dimensionRegionPaths('__proto__'), ['dimensions/minecraft/__proto__/region']);
  assert.equal(VANILLA_DIMENSION_IDS.length, 3);
});
