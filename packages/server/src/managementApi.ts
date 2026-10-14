import { Hono } from 'hono';
import { bearer, createAuthorization, REQUIRED_ROLE } from './auth.js';
import { asCreatableRole, type UserService } from './users.js';
import { AdminError } from './errors.js';
import { readLimitedBody } from './limitedBody.js';

const adminErrorStatusMap = {
  USER_NOT_FOUND: 404,
  USER_EXISTS: 409,
  FORBIDDEN: 403,
  INVALID_INPUT: 400,
} as const;

/** HTTP authorization stays here; trusted database operators use server/admin. */
export function createManagementApi(service: UserService) {
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
