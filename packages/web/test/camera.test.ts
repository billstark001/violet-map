import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCameraDraft } from '../src/state/camera.js';

test('camera drafts reject blank/nonfinite fields and normalize angles without clamping world coordinates', () => {
  const valid = { x: '-32000000.5', y: '384', z: '0', yaw: '540', pitch: '180' };
  const parsed = parseCameraDraft(valid);
  assert.ok(parsed);
  assert.equal(parsed.x, -32000000.5);
  assert.equal(parsed.yaw, -Math.PI);
  assert.ok(parsed.pitch < Math.PI / 2);
  for (const field of ['x', 'y', 'z', 'yaw', 'pitch']) {
    for (const value of ['', ' ', 'NaN', 'Infinity', '-Infinity'])
      assert.equal(parseCameraDraft({ ...valid, [field]: value }), null);
  }
});
