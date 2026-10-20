import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiTokenKey, apiUrl, initializeRuntime } from '../src/runtime.js';

const full = {
  protocolVersion: 2,
  resourcesProtocol: 1,
  delivery: {
    mode: 'server',
    families: [
      'chunk',
      'texture',
      'atlas-image',
      'atlas-manifest',
      'asset-bundle',
      'game-data',
      'top-map-tile',
      'overlay-media',
    ],
  },
  worldReads: true,
  contentReads: true,
  contentWrites: false,
  adminApi: true,
  users: true,
  worldWrites: true,
  dataWrites: true,
  diagnostics: true,
  authMode: 'users',
};

test('runtime configuration only falls back on explicit 404 and isolates API token keys', async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const calls: string[] = [];
  let api = 'https://api.test/violet/';
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return String(input).endsWith('runtime-config.json') ? Response.json({ apiBaseUrl: api }) : Response.json(full);
  };
  await initializeRuntime({ origin: 'https://map.test', staticBase: '/map/' });
  assert.equal(calls[0], 'https://map.test/map/runtime-config.json');
  assert.equal(apiUrl('api/worlds'), 'https://api.test/violet/api/worlds');
  const key = apiTokenKey('admin');
  api = 'https://second.test/';
  await initializeRuntime({ origin: 'https://map.test', staticBase: '/map/' });
  assert.notEqual(apiTokenKey('admin'), key);
  globalThis.fetch = async () => new Response('invalid', { status: 500 });
  await assert.rejects(initializeRuntime(), /HTTP 500/);
  globalThis.fetch = async () => new Response('{bad', { headers: { 'content-type': 'application/json' } });
  await assert.rejects(initializeRuntime());
  globalThis.fetch = async (input) =>
    String(input).endsWith('runtime-config.json')
      ? new Response(null, { status: 404 })
      : new Response(null, { status: 404 });
  await assert.rejects(initializeRuntime({ origin: 'https://map.test', fallbackApi: '/violet/' }), /404/);
  assert.equal(apiUrl('api/worlds'), 'https://map.test/violet/api/worlds');
  globalThis.fetch = async (input) =>
    String(input).endsWith('runtime-config.json') ? Response.json({}) : new Response(null, { status: 500 });
  await assert.rejects(initializeRuntime(), /HTTP 500/);
});
