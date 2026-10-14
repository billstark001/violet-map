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
