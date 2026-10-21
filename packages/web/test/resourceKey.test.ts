import assert from 'node:assert/strict';
import { test } from 'node:test';
import 'fake-indexeddb/auto';
import { buildRenderKey } from '../src/render/resourceKey.js';
import { clearMeshCache, getCachedFull, putCachedFull, setMeshCacheEnabled } from '../src/meshCache.js';

const resources: Parameters<typeof buildRenderKey>[0] = {
  atlasKey: 'atlas',
  bundle: { models: {}, blockstates: {} },
  blockInfo: {},
  biomes: { default: { temperature: 0.8, downfall: 0.4, effects: { water_color: 1, sky_color: 2, fog_color: 3 } } },
  dimensions: { overworld: { hasSkyLight: true, ambientLight: 0, sky: 'normal', defaultBiome: 'default' } },
  grassMap: new Uint8Array([1, 2, 3, 255]),
  foliageMap: null,
};

test('biome and dimension edits miss stale persistent meshes while reordered JSON reuses them', async (t) => {
  setMeshCacheEnabled(true);
  await clearMeshCache();
  t.after(() => clearMeshCache());
  const renderKey = buildRenderKey(resources);
  assert.ok(renderKey.startsWith('mesh-v18-shared-tints-canonical-json:'));
  assert.equal(buildRenderKey({ ...resources, bundle: { blockstates: {}, models: {} } }), renderKey);
  const parts = { world: 'world', dimension: 'overworld', renderKey, cx: 0, cz: 0, contentKey: 'same-nbt' };
  await putCachedFull(parts, []);
  assert.deepEqual(await getCachedFull(parts), []);
  const changed = structuredClone(resources);
  changed.biomes.default.effects.water_color = 0xff00ff;
  const changedDimension = structuredClone(resources);
  changedDimension.dimensions.overworld.hasSkyLight = false;
  for (const next of [changed, changedDimension]) {
    const nextKey = buildRenderKey(next);
    assert.notEqual(nextKey, renderKey);
    assert.equal(await getCachedFull({ ...parts, renderKey: nextKey }), null);
  }
});

test('render identities reject non-JSON inputs without evaluating accessors', () => {
  let invoked = false;
  const bundle = Object.defineProperty({}, 'models', {
    enumerable: true,
    get() {
      invoked = true;
      return {};
    },
  });
  assert.throws(() => buildRenderKey({ ...resources, bundle: bundle as typeof resources.bundle }), /accessors/);
  assert.equal(invoked, false);
  assert.throws(() => buildRenderKey({ ...resources, blockInfo: { invalid: undefined } as never }), /finite JSON/);
});
