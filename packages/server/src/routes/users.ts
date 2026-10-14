import { Hono } from 'hono';
import { createAuthorization, REQUIRED_ROLE } from '../auth.js';
import type { UserService } from '../users.js';
import { asCreatableRole } from '@violet-map/core/contracts';
import { AdminError } from '../errors.js';

const adminErrorStatusMap = {
  USER_NOT_FOUND: 404,
  USER_EXISTS: 409,
  FORBIDDEN: 403,
  INVALID_INPUT: 400,
} as const;

/** HTTP authorization stays here; trusted database operators use server/admin. */
export function createUserRoutes(service: UserService) {
  const app = new Hono();
  const { requireRole, principalFor } = createAuthorization(service);
  app.onError((error, c) => {
    if (error instanceof AdminError) {
      const status = adminErrorStatusMap[error.code] ?? 400;
      return c.json({ code: error.code, error: error.message }, status);
    }
    return c.json({ code: 'INTERNAL_ERROR', error: 'management operation failed' }, 500);
  });
  app.use('/api/admin/users', requireRole(REQUIRED_ROLE.users));
  app.use('/api/admin/users/*', requireRole(REQUIRED_ROLE.users));
  app.get('/api/admin/users', async (c) => c.json(await service.listUsers()));
  app.post('/api/admin/users', async (c) => {
    const body = await c.req.json().catch(() => null);
    const role = asCreatableRole(body?.role);
    if (!role || typeof body?.username !== 'string' || typeof body?.password !== 'string')
      throw new AdminError('INVALID_INPUT', 'username, password, and a non-special role are required');
    return c.json(await service.createUser({ username: body.username, password: body.password, role }), 201);
  });
  app.patch('/api/admin/users/:username', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new AdminError('INVALID_INPUT', 'invalid user update');
    const role = body.role === undefined ? undefined : asCreatableRole(body.role);
    if (
      (body.role !== undefined && !role) ||
      (body.password !== undefined && typeof body.password !== 'string') ||
      (body.enabled !== undefined && typeof body.enabled !== 'boolean')
    )
      throw new AdminError('INVALID_INPUT', 'invalid password, enabled flag, or non-special role');
    return c.json(
      await service.updateUser(c.req.param('username'), { password: body.password, role, enabled: body.enabled }),
    );
  });
  app.delete('/api/admin/users/:username', async (c) => {
    await service.deleteUser(c.req.param('username'));
    return c.json({ ok: true });
  });
  app.post('/api/admin/users/:username/credentials', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (typeof body?.expiresInSeconds !== 'number')
      throw new AdminError('INVALID_INPUT', 'expiresInSeconds is required');
    return c.json(
      await service.issueCredential(c.req.param('username'), body.expiresInSeconds, (await principalFor(c))!),
      201,
    );
  });
  app.delete('/api/admin/users/:username/credentials', async (c) => {
    await service.revokeUserCredentials(c.req.param('username'));
    return c.json({ ok: true });
  });
  return app;
}
