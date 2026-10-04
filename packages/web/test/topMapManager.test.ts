import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import * as THREE from 'three';
import { TopMapManager } from '../src/render/topMapManager.js';

test('a transient manifest failure is retried on a later update', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new Error('temporary outage');
    return Response.json({ hasTopMap: false, world: 'world', dimension: 'minecraft:overworld' });
  };
  const manager = new TopMapManager(new THREE.Scene(), {} as never);
  try {
    manager.configure('world', 'minecraft:overworld', true);
    await setImmediate();
    assert.equal(manager.diagnosticSnapshot().manifestLoaded, false);
    const camera = new THREE.OrthographicCamera(-10, 10, 10, -10);
    camera.position.set(0, 100, 0);
    manager.update(camera, performance.now() + 6000, { mode: 'top' });
    await setImmediate();
    assert.equal(calls, 2);
    assert.equal(manager.diagnosticSnapshot().manifestLoaded, true);
  } finally {
    manager.dispose();
    globalThis.fetch = originalFetch;
  }
});
