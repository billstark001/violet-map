import assert from 'node:assert/strict';
import { test } from 'node:test';
import { artifactRef } from '../src/contentAddressed.js';
import { verifyPublicArtifact } from '../src/publicArtifact.js';

test('public artifact verification checks anonymous HTTP, exact cache directives, CORS and bytes through one API', async (t) => {
  const ref = artifactRef(new Uint8Array([1, 2]), 'image/png', 'png');
  let status = 200,
    bytes = new Uint8Array([1, 2]),
    cancelled = false;
  const headers: Record<string, string> = {
    'content-type': 'image/png',
    'cache-control': 'public, max-age=10, immutable',
    'access-control-allow-origin': 'https://viewer.test',
  };
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options?.credentials, 'omit');
    assert.equal(options?.redirect, 'error');
    assert.equal(new Headers(options?.headers).get('authorization'), null);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(body, { status, headers });
  });
  const check = () => verifyPublicArtifact(ref, 'https://objects.test/object', { origin: 'https://viewer.test' });
  await check();
  headers['cache-control'] = 'public, not-immutable';
  await assert.rejects(check(), /HTTP\/CORS/);
  assert.equal(cancelled, true);
  headers['cache-control'] = 'public, immutable';
  headers['access-control-allow-origin'] = 'https://wrong.test';
  await assert.rejects(check(), /HTTP\/CORS/);
  headers['access-control-allow-origin'] = '*';
  status = 206;
  await assert.rejects(check(), /HTTP\/CORS/);
  status = 200;
  bytes = new Uint8Array([2, 1]);
  await assert.rejects(check(), /do not match/);
  bytes = new Uint8Array([1, 2, 3]);
  await assert.rejects(check(), /exceeds/);
});
