import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashString32, hashBytes32 } from '../src/hash.js';

test('shared fingerprints retain FNV vectors, unsigned results and seeded streaming', () => {
  assert.equal(hashString32(''), 0x811c9dc5);
  assert.equal(hashString32('hello'), 0x4f9f2cab);
  assert.equal(hashBytes32(new TextEncoder().encode('hello')), 0x4f9f2cab);
  assert.equal(hashString32('lo', hashString32('hel')), hashString32('hello'));
  assert.equal(
    hashBytes32(new Uint8Array([3]), hashBytes32(new Uint8Array([1, 2]))),
    hashBytes32(new Uint8Array([1, 2, 3])),
  );
  const text = '群系🌸';
  let reference = 0x811c9dc5;
  for (let index = 0; index < text.length; index++)
    reference = Math.imul(reference ^ text.charCodeAt(index), 0x01000193);
  assert.equal(hashString32(text), reference >>> 0);
});
