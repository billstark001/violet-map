import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hexToRgb, resolveBiomeColors } from '../src/colors.js';

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
