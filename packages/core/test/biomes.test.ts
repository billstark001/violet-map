import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';
import { parseBiomeMap } from '../src/biomes.js';
import { defaultDataUrl } from '../src/defaults.js';

const biome = {
  temperature: -0.5,
  downfall: 1.5,
  effects: { sky_color: 0, fog_color: 0xffffff, water_color: 0x123456 },
};

test('biome validation accepts packaged defaults and preserves custom fields and climate ranges', async () => {
  const defaults = JSON.parse(await fs.readFile(defaultDataUrl('biomes.json'), 'utf8'));
  assert.equal(parseBiomeMap(defaults), defaults);
  const custom = { 'custom:cold': { ...biome, extension: { enabled: true } } };
  assert.equal(parseBiomeMap(custom), custom);
  assert.deepEqual(parseBiomeMap({}), {});
});

test('malformed biome definitions cannot reach color resolution', () => {
  for (const value of [
    null,
    [],
    { x: null },
    { x: {} },
    { x: { ...biome, temperature: '0.8' } },
    { x: { ...biome, downfall: NaN } },
    { x: { ...biome, effects: [] } },
  ])
    assert.throws(() => parseBiomeMap(value), /biome/);
  for (const color of [-1, 0x1000000, 0.5, '123', null, undefined])
    assert.throws(() => parseBiomeMap({ x: { ...biome, effects: { ...biome.effects, water_color: color } } }), /color/);
  for (const modifier of ['unknown', ['swamp'], null])
    assert.throws(
      () => parseBiomeMap({ x: { ...biome, effects: { ...biome.effects, grass_color_modifier: modifier } } }),
      /modifier/,
    );
});
