import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssetBundle, BlockInfo, Direction, ModelElementJson } from '@violet-map/core/assets';
import { AIR, type BlockStateRef } from '@violet-map/core/domain';
import { ModelBaker, MISSING_TEXTURE } from '../src/model.js';
import { meshSection, type MesherResources, type WorldView } from '../src/mesher/full.js';

const DIRECTIONS: Direction[] = ['down', 'up', 'north', 'south', 'west', 'east'];
const RECT = { u0: 0, v0: 0, u1: 1, v1: 1 };
const BASE_INFO: BlockInfo = { occludes: false, emit: 0, filter: 0, layer: 'cutout', tint: 'none' };

function cube(
  from: [number, number, number] = [0, 0, 0],
  to: [number, number, number] = [16, 16, 16],
): ModelElementJson {
  return { from, to, faces: Object.fromEntries(DIRECTIONS.map((dir) => [dir, { texture: '#all', cullface: dir }])) };
}

function resources(
  definitions: Record<string, { info?: Partial<BlockInfo>; elements?: ModelElementJson[] }>,
): MesherResources {
  const bundle: AssetBundle = { blockstates: {}, models: {} };
  for (const [name, definition] of Object.entries(definitions)) {
    bundle.blockstates[name] = { variants: { '': { model: name } } };
    bundle.models[name] = { textures: { all: 'test:block/texture' }, elements: definition.elements ?? [cube()] };
  }
  return {
    baker: new ModelBaker(bundle),
    info: (name) => ({ ...BASE_INFO, ...definitions[name]?.info }),
    atlas: { 'test:block/texture': RECT, [MISSING_TEXTURE]: RECT },
    textureHasAlpha: { 'test:block/texture': true },
    tint: () => [1, 1, 1],
  };
}

function world(blocks: Array<[number, number, number, string]>): WorldView {
  const states = new Map<string, BlockStateRef>(
    blocks.map(([x, y, z, name]) => [`${x},${y},${z}`, { name, properties: {} }]),
  );
  return {
    getBlock: (x, y, z) => states.get(`${x},${y},${z}`) ?? AIR,
    getBiome: () => 'minecraft:plains',
    getSkyLight: () => 15,
    getBlockLight: () => 0,
  };
}

function quadCount(result: ReturnType<typeof meshSection>): number {
  return Object.values(result.layers).reduce((sum, mesh) => sum + mesh!.indices.length / 6, 0);
}

test('same-material culling removes touching glass faces while preserving porous leaves and different glass colors', () => {
  const res = resources({
    'test:glass': { info: { cullSameBlock: true } },
    'test:blue_glass': { info: { cullSameBlock: true, layer: 'translucent' } },
    'test:red_glass': { info: { cullSameBlock: true, layer: 'translucent' } },
    'test:leaves': {},
  });
  for (const [name, expected] of [
    ['test:glass', 10],
    ['test:blue_glass', 10],
    ['test:leaves', 12],
  ] as const) {
    const view = world([
      [1, 1, 1, name],
      [2, 1, 1, name],
    ]);
    assert.equal(quadCount(meshSection(res, view, 0, 0, 0, false)), expected, name);
  }
  assert.equal(
    quadCount(
      meshSection(
        res,
        world([
          [1, 1, 1, 'test:red_glass'],
          [2, 1, 1, 'test:blue_glass'],
        ]),
        0,
        0,
        0,
        false,
      ),
    ),
    12,
  );
});

test('glass culling works across chunk and section borders without sealing visibility', () => {
  const res = resources({ 'test:glass': { info: { cullSameBlock: true } } });
  for (const [blocks, neighbor] of [
    [
      [
        [15, 1, 1, 'test:glass'],
        [16, 1, 1, 'test:glass'],
      ],
      [1, 0, 0],
    ],
    [
      [
        [1, 15, 1, 'test:glass'],
        [1, 16, 1, 'test:glass'],
      ],
      [0, 1, 0],
    ],
    [
      [
        [1, 1, 15, 'test:glass'],
        [1, 1, 16, 'test:glass'],
      ],
      [0, 0, 1],
    ],
  ] as const) {
    const view = world(blocks.map((block) => [...block]));
    const first = meshSection(res, view, 0, 0, 0, false);
    assert.equal(quadCount(first), 5);
    assert.equal(quadCount(meshSection(res, view, ...neighbor, false)), 5);
    assert.ok(first.visibility > 0, 'glass must remain passable for section visibility');
  }
});

test('inset model faces do not falsely cover a neighboring glass face', () => {
  const res = resources({
    'test:pane': { info: { cullSameBlock: true }, elements: [cube([7, 0, 0], [9, 16, 16])] },
  });
  assert.equal(
    quadCount(
      meshSection(
        res,
        world([
          [1, 1, 1, 'test:pane'],
          [2, 1, 1, 'test:pane'],
        ]),
        0,
        0,
        0,
        false,
      ),
    ),
    12,
  );
  assert.equal(
    quadCount(
      meshSection(
        res,
        world([
          [1, 1, 1, 'test:pane'],
          [1, 1, 2, 'test:pane'],
        ]),
        0,
        0,
        0,
        false,
      ),
    ),
    10,
  );
});
