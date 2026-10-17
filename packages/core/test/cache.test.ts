import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LruCache } from '../src/cache.js';

test('cache eviction respects reads, replacements and both capacity limits', () => {
  const cache = new LruCache<string, string>({ maxEntries: 3, maxWeight: 6, weightOf: (value) => value.length });
  cache.set('a', 'aa').set('b', 'bb').set('c', 'cc');
  assert.equal(cache.get('a'), 'aa');
  assert.equal(cache.peek('b'), 'bb');
  cache.set('d', 'dd');
  assert.equal(cache.has('b'), false);
  assert.equal(cache.weight, 6);
  cache.set('a', 'aaaaa');
  assert.deepEqual([...cache], [['a', 'aaaaa']]);
  assert.equal(cache.weight, 5);
  cache.set('large', '1234567');
  assert.equal(cache.has('a'), true, 'an oversized item must not flush useful residents');
  assert.equal(cache.has('large'), false);
  cache.set('a', '1234567');
  assert.equal(cache.size, 0, 'an oversized replacement must drop its previous value');
  assert.equal(cache.weight, 0);
  cache.set('empty', '').set('x', '').set('y', '').set('z', '');
  assert.equal(cache.size, 3, 'zero-weight entries still obey the entry limit');
  cache.clear();
  assert.equal(cache.weight, 0);
  assert.equal(cache.size, 0);
});

test('disabled caches retain nothing and invalid limits or weights fail without corrupting residents', () => {
  assert.equal(new LruCache({ maxEntries: 0 }).set('x', 1).size, 0);
  for (const maxEntries of [-1, 0.5, NaN, Infinity]) assert.throws(() => new LruCache({ maxEntries }), RangeError);
  for (const maxWeight of [-1, NaN]) assert.throws(() => new LruCache({ maxEntries: 1, maxWeight }), RangeError);
  const cache = new LruCache<string, number>({ maxEntries: 1, weightOf: (weight) => weight });
  cache.set('a', 1);
  for (const value of [-1, NaN, Infinity]) assert.throws(() => cache.set('a', value), RangeError);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.weight, 1);
});

test('finite weight overflow cannot trap eviction and unbounded aggregates recover after deletion', () => {
  const bounded = new LruCache<string, number>({ maxEntries: 3, maxWeight: 1e308, weightOf: (value) => value });
  bounded.set('old', 1e308).set('new', 1e308);
  assert.deepEqual([...bounded], [['new', 1e308]]);
  assert.equal(bounded.weight, 1e308);
  bounded.delete('new');
  assert.equal(bounded.weight, 0);
  const unbounded = new LruCache<string, number>({ maxEntries: 3, weightOf: (value) => value });
  unbounded.set('a', 1e308).set('b', 1e308);
  assert.equal(unbounded.weight, Infinity);
  unbounded.delete('a');
  assert.equal(unbounded.weight, 1e308);
  unbounded.delete('b');
  assert.equal(unbounded.weight, 0);
});
