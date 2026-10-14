import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createManagementApi } from '../src/managementApi.js';
import { managementFixture } from './helpers/management.js';

for (const driver of ['pglite', 'postgres'] as const) {
  test(
    `HTTP management enforces roles and revokes credentials (${driver})`,
    { skip: driver === 'postgres' && !process.env.TEST_DATABASE_URL },
    async (t) => {
      const fixture = await managementFixture(t, driver);
      const app = createManagementApi(fixture.service);
      const request = (route: string, token?: string, method = 'GET', data?: unknown) =>
        app.request(route, {
          method,
          headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
          ...(data ? { body: JSON.stringify(data) } : {}),
        });
      assert.equal((await request('/api/admin/users')).status, 401);
      await fixture.service.createUser({ username: 'viewer_user', password: 'viewer-password', role: 'viewer' });
      const viewer = (await fixture.service.login('viewer_user', 'viewer-password'))!;
      assert.equal((await request('/api/admin/users', viewer.token)).status, 403);
      const login = await request('/api/auth/login', undefined, 'POST', {
        username: 'operator',
        password: 'operator-password',
      });
      assert.equal(login.status, 200);
      const root = await login.json();
      assert.equal((await request('/api/admin/users', root.token)).status, 200);
      assert.equal(
        (
          await request('/api/admin/users', root.token, 'POST', {
            username: 'other_user',
            password: 'long-password',
            role: 'admin',
          })
        ).status,
        201,
      );
      assert.equal(
        (
          await request('/api/admin/users', root.token, 'POST', {
            username: 'other_user',
            password: 'long-password',
            role: 'admin',
          })
        ).status,
        409,
      );
      assert.equal((await request('/api/admin/users/missing_user', root.token, 'DELETE')).status, 404);
      assert.equal(
        (await request('/api/admin/users/viewer_user', root.token, 'PATCH', { enabled: 'yes' })).status,
        400,
      );
      const issued = await request('/api/admin/users/viewer_user/credentials', root.token, 'POST', {
        expiresInSeconds: 600,
      });
      const token = (await issued.json()).token;
      assert.equal((await request('/api/auth/me', token)).status, 200);
      await request('/api/admin/users/viewer_user/credentials', root.token, 'DELETE');
      assert.equal((await request('/api/auth/me', token)).status, 401);
      assert.equal((await request('/api/auth/logout', root.token, 'POST')).status, 200);
      assert.equal((await request('/api/auth/me', root.token)).status, 401);
    },
  );
}
