import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { ContentValidationError } from '@violet-map/core/overlays';
import { readRequestJson } from '../src/httpBody.js';
import { createAuthRoutes } from '../src/routes/auth.js';
import { createUserRoutes } from '../src/routes/users.js';
import { mountResources } from '../src/routes/resources.js';
import { loadServerConfig } from '../src/configuration.js';
import type { UserService } from '../src/users.js';
import type { AppServices } from '../src/serviceTypes.js';

test('bounded JSON parsing handles exact limits, streamed overflow, malformed JSON and optional empty documents', async () => {
  const app = new Hono();
  app.post('/', async (c) => c.json(await readRequestJson(c, 8, { allowEmpty: true })));
  for (const [body, status] of [
    ['{"x":12}', 200],
    ['{"x":123}', 413],
    ['bad', 400],
    ['', 200],
  ] as const) {
    assert.equal((await app.request('/', { method: 'POST', body })).status, status);
  }
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(9));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = await app.request(
    new Request('http://fixture/', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }),
  );
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
});

test('login and all user mutations reject malformed and oversized JSON before invoking the service', async () => {
  const fail = async () => {
    throw new Error('business service must not run');
  };
  const service = {
    authenticateCredential: async () => ({ id: 'root', username: 'root', role: 'root', source: 'root' }),
    login: fail,
    createUser: fail,
    updateUser: fail,
    issueCredential: fail,
  } as unknown as UserService;
  const app = new Hono().route('/', createAuthRoutes(service)).route('/', createUserRoutes(service));
  for (const [url, method] of [
    ['/api/auth/login', 'POST'],
    ['/api/admin/users', 'POST'],
    ['/api/admin/users/viewer', 'PATCH'],
    ['/api/admin/users/viewer/credentials', 'POST'],
  ]) {
    for (const [body, status] of [
      ['{', 400],
      ['x'.repeat(16 * 1024 + 1), 413],
    ] as const) {
      const response = await app.request(url, { method, body, headers: { authorization: 'Bearer test' } });
      assert.equal(response.status, status, `${method} ${url}`);
      if (status === 400) assert.equal((await response.json()).code, 'INVALID_INPUT');
    }
  }
});

test('overlay projection preserves validation, errors and ETag revalidation in both delivery modes', async () => {
  for (const mode of ['server', 'public'] as const) {
    const config = loadServerConfig({ env: { DEPLOYMENT_PROFILE: 'public' } });
    config.resources.delivery.mode = mode;
    config.features.contentReads = mode === 'server';
    let reads = 0;
    const services = {
      content: mode === 'server' ? {} : undefined,
      resources: {
        overlays: async (id: string) => {
          reads++;
          if (id === 'bad') throw new ContentValidationError('bad map');
          return { layers: [], media: [] };
        },
      },
    } as unknown as AppServices;
    const app = new Hono();
    mountResources(app, config, services);
    for (const suffix of ['', '?dimension=overworld', '?dimension=overworld&viewId=v&delivery=public']) {
      const response = await app.request('/api/maps/map/overlays' + suffix);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, 'INVALID_CONTENT');
    }
    assert.equal(reads, 0);
    const url = '/api/maps/map/overlays?dimension=overworld&viewId=v';
    const response = await app.request(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal((await app.request(url, { headers: { 'if-none-match': response.headers.get('etag')! } })).status, 304);
    assert.deepEqual(await (await app.request(url.replace('/map/', '/bad/'))).json(), {
      code: 'INVALID_CONTENT',
      error: 'bad map',
    });
  }
});
