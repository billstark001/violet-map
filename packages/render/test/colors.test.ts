import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockTint, hexToRgb, resolveBiomeColors } from '../src/colors.js';

test('shared block tints preserve fixed overrides, state-dependent colors and biome fallbacks', () => {
  assert.deepEqual(
    blockTint('redstone', undefined, 'unknown', null, { name: 'wire', properties: { power: '15' } }),
    [1, 0.19999999999999996, 0],
  );
  assert.deepEqual(blockTint('stem', undefined, 'unknown', null, { name: 'stem', properties: { age: '7' } }), [
    224 / 255,
    199 / 255,
    28 / 255,
  ]);
  assert.deepEqual(blockTint('water', 0x123456), hexToRgb(0x123456));
  assert.deepEqual(blockTint('grass', undefined, 'unknown'), [0.48, 0.68, 0.29]);
  assert.equal(blockTint('none', undefined), blockTint('none', undefined), 'untinted vertices reuse a constant');
});

test('truncated colormaps and invalid climate values use the fallback color', () => {
  const biomes = {
    short: {
      temperature: 0.8,
      downfall: 0.4,
      effects: { sky_color: 0, fog_color: 0, water_color: 0 },
    },
    invalid: {
      temperature: NaN,
      downfall: 0.4,
      effects: { sky_color: 0, fog_color: 0, water_color: 0 },
    },
  };
  const colors = resolveBiomeColors(biomes, new Uint8Array(4), new Uint8Array(256 * 256 * 4));
  assert.deepEqual(colors.short.grass, hexToRgb(0x48b518));
  assert.deepEqual(colors.invalid.foliage, hexToRgb(0x48b518));
});

test('biome color dictionaries preserve prototype-named keys without inherited color entries', () => {
  const definition = {
    temperature: 0.8,
    downfall: 0.4,
    effects: { sky_color: 0, fog_color: 0, water_color: 0xabcdef },
  };
  const input = Object.fromEntries(['__proto__', 'constructor'].map((name) => [name, definition]));
  const colors = resolveBiomeColors(input, null, null);
  assert.equal(Object.getPrototypeOf(colors), null);
  assert.deepEqual(Object.keys(colors), ['__proto__', 'constructor']);
  assert.deepEqual(colors.__proto__.water, hexToRgb(0xabcdef));
  assert.deepEqual(colors.constructor.water, hexToRgb(0xabcdef));
  assert.equal(colors.toString, undefined);
});
