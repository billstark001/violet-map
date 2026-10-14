import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initializeRuntime, apiUrl, apiTokenKey } from '../src/runtime.js';
const full = {
  protocolVersion: 1,
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
  await initializeRuntime({ origin: 'https://map.test', fallbackApi: '/violet/' });
  assert.equal(apiUrl('api/worlds'), 'https://map.test/violet/api/worlds');
  globalThis.fetch = async (input) =>
    String(input).endsWith('runtime-config.json') ? Response.json({}) : new Response(null, { status: 500 });
  await assert.rejects(initializeRuntime(), /HTTP 500/);
});
