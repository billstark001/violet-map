import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildViewUrl, lookAtTargetFromParams, readInitialView } from '../src/render/cameraState.js';
import { browserStorage, readStored } from '../src/browserStorage.js';

test('partial camera URLs retain safe defaults rather than converting absent values to zero', () => {
  assert.deepEqual(readInitialView('?x=42', null), { x: 42, y: 120, z: 8, yaw: 0, pitch: 0, hasAngles: false });
  const angles = readInitialView('?yaw=1&pitch=', null);
  assert.equal(angles.y, 120);
  assert.equal(angles.z, 8);
  assert.equal(angles.hasAngles, true);
  assert.equal(angles.pitch, 0);
  assert.deepEqual(lookAtTargetFromParams(new URLSearchParams('lookAtX=0'), { x: 42, y: 120, z: 8 }), [0, 120, 7]);
  assert.equal(lookAtTargetFromParams(new URLSearchParams(), { x: 0, y: 0, z: 0 }), null);
});

test('camera state rejects blank/nonfinite URL numbers and malformed saved values', () => {
  for (const raw of [null, '', '{', 'null', '42', '[]', '"bad"']) {
    assert.equal(readInitialView('', raw).y, 120);
    assert.equal(readInitialView('?x= &y=Infinity&z=NaN', raw).y, 120);
  }
  const saved = JSON.stringify({ x: 7, y: 66, z: 0, yaw: 1, pitch: 0 });
  assert.equal(readInitialView('', saved).y, 66);
  assert.equal(readInitialView('?x=10', saved).x, 10);
  const url = buildViewUrl('/map/', '?world=hello&lookAtX=1', '#anchor', { x: 0, y: 120, z: 8, yaw: 0, pitch: 0 });
  assert.match(url, /^\/map\/\?world=hello&x=0.00&y=120.00&z=8.00&yaw=0.0000&pitch=0.0000#anchor$/);
});

test('restricted browser storage is harmless both when acquiring it and reading keys', () => {
  assert.equal(
    readStored(
      {
        getItem: () => {
          throw new Error('blocked');
        },
      },
      'camera',
    ),
    null,
  );
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('blocked');
      },
    });
    assert.equal(browserStorage('localStorage'), null);
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
