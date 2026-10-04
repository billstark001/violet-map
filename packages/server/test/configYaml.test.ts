import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfigYaml } from '../src/configYaml.js';

test('YAML configuration supports nested maps, sequences, and quoted scalars', () => {
  assert.deepEqual(
    parseConfigYaml(
      `server:\n  port: 3300\n  labels:\n    title: "Map: #1"\nassetsDirs:\n  - ./assets/base\n  - ./assets/override\n`,
    ),
    {
      server: { port: 3300, labels: { title: 'Map: #1' } },
      assetsDirs: ['./assets/base', './assets/override'],
    },
  );
});

test('YAML configuration rejects non-mappings and malformed input', () => {
  assert.throws(() => parseConfigYaml('- a\n- b'), /root must be a YAML mapping/);
  assert.throws(() => parseConfigYaml('server: [unterminated'), Error);
});
