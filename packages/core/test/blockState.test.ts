import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockStateKey } from '../src/domain.js';

test('block state identity ignores property insertion order and escapes delimiters without collisions', () => {
  assert.equal(
    blockStateKey({ name: 'stone', properties: { b: '2', a: '1' } }),
    blockStateKey({ name: 'stone', properties: { a: '1', b: '2' } }),
  );
  assert.notEqual(
    blockStateKey({ name: 'stone', properties: { a: '1,b=2' } }),
    blockStateKey({ name: 'stone', properties: { a: '1', b: '2' } }),
  );
});
