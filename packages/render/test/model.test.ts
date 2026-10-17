import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MISSING_TEXTURE, ModelBaker } from '../src/model.js';
import type { AssetBundle, ModelElementJson } from '@violet-map/core/assets';

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

test('texture variables may use prototype names without breaking inheritance or missing fallback', () => {
  const bundle: AssetBundle = {
    blockstates: { 'test:block': { variants: { '': { model: 'test:child' } } } },
    models: {
      'test:parent': {
        textures: JSON.parse('{"constructor":"test:parent_texture","__proto__":"test:parent_proto"}'),
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            faces: {
              up: { texture: '#constructor' },
              north: { texture: '#__proto__' },
              south: { texture: '#hasOwnProperty' },
            },
          },
        ],
      },
      'test:child': {
        parent: 'test:parent',
        textures: JSON.parse('{"constructor":"#toString","toString":"test:child_texture"}'),
      },
    },
  };
  const quads = new ModelBaker(bundle).getQuads({ name: 'test:block', properties: {} }, 0);
  assert.deepEqual(
    quads.map((quad) => quad.texture),
    ['test:child_texture', 'test:parent_proto', MISSING_TEXTURE],
  );
});

test('registered models reuse baked variants across entity instances and block states', () => {
  const bundle: AssetBundle = {
    blockstates: { 'minecraft:test': { variants: { '': { model: 'minecraft:block/test' } } } },
    models: {
      'minecraft:block/test': {
        elements: [{ from: [0, 0, 0], to: [8, 16, 16], faces: { up: { texture: 'minecraft:block/stone' } } }],
      },
    },
  };
  const baker = new ModelBaker(bundle);
  const quads = baker.getModelQuads('block/test');
  const original = quads[0].positions.slice();
  assert.equal(baker.getModelQuads('minecraft:block/test'), quads);
  assert.equal(baker.getQuads({ name: 'minecraft:test', properties: {} }, 0), quads);
  const rotated = baker.getModelQuads('block/test', 90);
  assert.notEqual(rotated, quads);
  assert.equal(baker.getModelQuads('block/test', 90), rotated);
  assert.notDeepEqual(rotated[0].positions, original);
  assert.deepEqual(quads[0].positions, original);
});
