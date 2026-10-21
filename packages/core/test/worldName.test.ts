import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertWorldName, isWorldName } from '../src/worldName.js';

test('world names cannot collapse into the storage root or traverse directories', () => {
  for (const value of [
    '',
    '.',
    '..',
    '../world',
    'a/b',
    'a\\b',
    'world..',
    'world ',
    'a:b',
    'NUL',
    'con.dat',
    'LPT1',
    'COM¹',
    'x\u0000y',
    'x\ny',
    'x'.repeat(256),
    null,
    1,
  ]) {
    assert.equal(isWorldName(value), false);
    assert.throws(() => assertWorldName(value as string), /invalid world name/);
  }
  for (const value of [
    'world',
    '.hidden',
    'a.b-c_1',
    'Ancient City Restoration',
    'Surv#Vanilla',
    '世界',
    'a%20b',
    'a&b',
  ])
    assert.equal(isWorldName(value), true);
});
