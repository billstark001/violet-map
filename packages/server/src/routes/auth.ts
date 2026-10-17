import { Hono } from 'hono';
import { bearer, createAuthorization, REQUIRED_ROLE } from '../auth.js';
import type { UserService } from '../users.js';

import { AdminError } from '../errors.js';
import { readLimitedBody } from '@violet-map/core/http';

const adminErrorStatusMap = {
  USER_NOT_FOUND: 404,
  USER_EXISTS: 409,
  FORBIDDEN: 403,
  INVALID_INPUT: 400,
} as const;

/** HTTP authorization stays here; trusted database operators use server/admin. */
export function createAuthRoutes(service: UserService) {
  const app = new Hono();
  const { requireRole, principalFor } = createAuthorization(service);
  app.onError((error, c) => {
    if (error instanceof AdminError) {
      const status = adminErrorStatusMap[error.code] ?? 400;
      return c.json({ code: error.code, error: error.message }, status);
    }
    return c.json({ code: 'INTERNAL_ERROR', error: 'management operation failed' }, 500);
  });
  app.post('/api/auth/login', async (c) => {
    const bytes = await readLimitedBody(c.req.raw, 16 * 1024);
    if (!bytes) return c.json({ error: 'request body too large' }, 413);
    let body;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new AdminError('INVALID_INPUT', 'invalid JSON');
    }
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
