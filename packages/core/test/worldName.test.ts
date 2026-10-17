import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertWorldName, isWorldName } from '../src/worldName.js';

test('world names cannot collapse into the storage root or traverse directories', () => {
  for (const value of ['', '.', '..', '../world', 'a/b', 'a\\b', 'world name', null, 1]) {
    assert.equal(isWorldName(value), false);
    assert.throws(() => assertWorldName(value as string), /invalid world name/);
  }
  for (const value of ['world', '.hidden', 'world..', 'a.b-c_1']) assert.equal(isWorldName(value), true);
});
