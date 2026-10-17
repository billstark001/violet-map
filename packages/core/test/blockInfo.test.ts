import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyBlockInfoOverrides, createBlockInfoMap } from '../src/blockInfo.js';

test('registry conversion and ordered wildcard patches have identical shared semantics', () => {
  const map = createBlockInfoMap([
    { name: 'stone', boundingBox: 'block' },
    { name: 'glass', transparent: true, boundingBox: 'block' },
    { name: 'oak_leaves', transparent: true, filterLight: 1 },
    { name: 'spruce_leaves', transparent: true },
  ]);
  assert.equal(map['minecraft:stone'].occludes, true);
  assert.equal(map['minecraft:glass'].filter, 0);
  applyBlockInfoOverrides(map, {
    'minecraft:*_leaves': { tint: 'foliage', filter: 1 },
    'minecraft:spruce_leaves': { fixedTint: 12 },
    'custom:block': { emit: 15 },
  });
  assert.equal(map['minecraft:oak_leaves'].tint, 'foliage');
  assert.equal(map['minecraft:spruce_leaves'].filter, 1);
  assert.equal(map['minecraft:spruce_leaves'].fixedTint, 12);
  assert.deepEqual(map['custom:block'], { occludes: false, emit: 15, filter: 0, layer: 'cutout', tint: 'none' });
  applyBlockInfoOverrides(map, { 'minecraft:oak_*': { emit: 3 } });
  assert.equal(map['minecraft:spruce_leaves'].emit, 0, 'entries must never share mutable defaults');
});

test('override dictionary keys cannot replace the map prototype and regex punctuation stays literal', () => {
  const map = createBlockInfoMap([{ name: 'a.b' }, { name: 'axb' }]);
  const prototype = Object.getPrototypeOf(map);
  applyBlockInfoOverrides(map, JSON.parse('{"__proto__":{"emit":15},"minecraft:a.*":{"emit":7}}'));
  assert.equal(Object.getPrototypeOf(map), prototype);
  assert.equal(Object.hasOwn(map, '__proto__'), true);
  assert.equal(map['__proto__'].emit, 15);
  assert.equal(map['minecraft:a.b'].emit, 7);
  assert.equal(map['minecraft:axb'].emit, 0);
});
