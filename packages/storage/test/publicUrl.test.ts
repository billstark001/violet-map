import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicObjectUrl } from '../src/publicUrl.js';

test('public object URLs preserve mount roots and encode each object-key segment', () => {
  const url = createPublicObjectUrl('https://media.example/blobs');
  assert.equal(url('sha256/ab/abcdef'), 'https://media.example/blobs/sha256/ab/abcdef');
  assert.equal(url('a space/#?%/中文'), 'https://media.example/blobs/a%20space/%23%3F%25/%E4%B8%AD%E6%96%87');
  assert.equal(url('%2e%2e/file'), 'https://media.example/blobs/%252e%252e/file');
  assert.throws(() => url('../private'), /invalid storage path/);
  assert.throws(() => url(''), /empty/);
  for (const base of [
    '//media.example',
    'file:///tmp/data',
    'https://u:p@media.example',
    'https://media.example/?token=a',
    'https://media.example/#x',
  ])
    assert.throws(() => createPublicObjectUrl(base));
});
