import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanStoragePath, joinStoragePath } from '../src/storage/paths.js';

test('storage paths reject parent components even when normalization stays within the root', () => {
  assert.throws(() => cleanStoragePath('world/region/../level.dat'), /invalid storage path/);
  assert.throws(() => joinStoragePath('world', 'region/../level.dat'), /invalid storage path/);
  assert.equal(cleanStoragePath('world//region/r.0.0.mca'), 'world/region/r.0.0.mca');
});
