import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeApiBaseUrl, apiUrl, resolveApiResourceUrl, parseFrontendRuntimeConfig } from '../src/contracts.js';

test('API URL resolution preserves proxy prefixes and confines response resources', () => {
  const base = normalizeApiBaseUrl('https://api.example.test/violet', 'https://map.example.test');
  assert.equal(base, 'https://api.example.test/violet/');
  assert.equal(apiUrl(base, 'api/worlds'), 'https://api.example.test/violet/api/worlds');
  assert.equal(
    resolveApiResourceUrl(base, '/api/assets/atlas/key'),
    'https://api.example.test/violet/api/assets/atlas/key',
  );
  assert.equal(
    resolveApiResourceUrl(base, 'api/assets/atlas/key'),
    'https://api.example.test/violet/api/assets/atlas/key',
  );
  assert.throws(() => resolveApiResourceUrl(base, 'https://other.test/api/texture'), /configured API/);
  assert.throws(() => resolveApiResourceUrl(base, '../assets/atlas'), /configured API/);
  assert.throws(() => apiUrl(base, 'api/../private'), /invalid API/);
  assert.throws(() => apiUrl(base, '/api/worlds'), /invalid API/);
  assert.throws(() => normalizeApiBaseUrl('https://secret:token@api.test', 'https://map.test'), /credentials/);
  assert.throws(() => parseFrontendRuntimeConfig({ apiBaseUrl: 3 }), /string/);
  assert.throws(() => parseFrontendRuntimeConfig({ unexpected: 'value' }), /unknown/);
});
