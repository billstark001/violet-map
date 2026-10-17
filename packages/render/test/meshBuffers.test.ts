import assert from 'node:assert/strict';
import { test } from 'node:test';
import { meshByteLength } from '../src/meshBuffers.js';

test('mesh memory distinguishes encoded attributes from unique retained backing allocations', () => {
  const backing = new ArrayBuffer(4096);
  const mesh = {
    positions: new Uint16Array(backing, 0, 3),
    colors: new Uint8Array(backing, 6, 3),
    lights: new Uint8Array(backing, 9, 2),
    animations: new Uint16Array(backing, 12, 1),
    indices: new Uint16Array(backing, 14, 3),
  };
  assert.equal(meshByteLength(mesh), 19);
  assert.equal(meshByteLength(mesh, 'retained'), 4096);
  assert.equal(meshByteLength({ ...mesh, uvs: new Uint16Array(8) }), 35);
  assert.equal(meshByteLength({ ...mesh, uvs: new Uint16Array(8) }, 'retained'), 4112);
});
