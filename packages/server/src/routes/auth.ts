import { Hono } from 'hono';
import { bearer, createAuthorization, REQUIRED_ROLE } from '../auth.js';
import type { UserService } from '../users.js';

import { adminFailure } from '../adminErrors.js';
import { readRequestJson } from '../httpBody.js';
import { AdminError } from '../errors.js';

/** HTTP authorization stays here; trusted database operators use server/admin. */
export function createAuthRoutes(service: UserService) {
  const app = new Hono();
  const { requireRole, principalFor } = createAuthorization(service);
  app.onError(adminFailure);
  app.post('/api/auth/login', async (c) => {
    const body = (await readRequestJson(c, 16 * 1024)) as Record<string, unknown> | null;
    if (!body || typeof body.username !== 'string' || typeof body.password !== 'string')
      throw new AdminError('INVALID_INPUT', 'username and password are required');
    const credential = await service.login(body.username, body.password);
    return credential ? c.json(credential) : c.json({ code: 'UNAUTHENTICATED', error: 'invalid credentials' }, 401);
  });
  app.get('/api/auth/me', requireRole(REQUIRED_ROLE.identity), async (c) => {
    const principal = (await principalFor(c))!;
    return c.json({ id: principal.id, username: principal.username, role: principal.role });
  });
  app.post('/api/auth/logout', requireRole(REQUIRED_ROLE.identity), async (c) => {
    await service.revokeCredential(bearer(c)!);
    return c.json({ ok: true });
  });
  return app;
}
