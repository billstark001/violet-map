import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelBaker } from '../src/model.js';
import type { AssetBundle, ModelElementJson } from '../src/types.js';

test('malformed model faces and perpendicular rescale do not produce invalid geometry', () => {
  const bundle: AssetBundle = {
    blockstates: { 'minecraft:test': { variants: { '': { model: 'minecraft:block/test' } } } },
    models: {
      'minecraft:block/test': {
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            rotation: { origin: [8, 8, 8], axis: 'x', angle: 90, rescale: true },
            faces: {
              north: { texture: 'minecraft:block/stone' },
              bogus: { texture: 'minecraft:block/stone' },
            } as unknown as ModelElementJson['faces'],
          },
        ],
      },
    },
  };
  const quads = new ModelBaker(bundle).getQuads({ name: 'minecraft:test', properties: {} }, 0);
  assert.equal(quads.length, 1);
  assert.ok([...quads[0].positions].every((position) => Number.isFinite(position) && Math.abs(position) < 2));
});

test('empty weighted variants and malformed multipart entries do not abort meshing', () => {
  const model = {
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: { up: { texture: 'minecraft:block/stone' } },
      },
    ],
  } as unknown as AssetBundle['models'][string];
  const bundle = {
    blockstates: {
      'minecraft:empty': { variants: { '': [] } },
      'minecraft:mixed': {
        multipart: [
          null,
          { when: { OR: 'invalid' }, apply: { model: 'minecraft:block/test' } },
          { apply: { model: null } },
          { apply: { model: 'minecraft:block/test' } },
        ],
      },
    },
    models: { 'minecraft:block/test': model },
  } as unknown as AssetBundle;
  const baker = new ModelBaker(bundle);
  assert.deepEqual(baker.getQuads({ name: 'minecraft:empty', properties: {} }, 0), []);
  assert.equal(baker.getQuads({ name: 'minecraft:mixed', properties: {} }, 0).length, 1);
});
