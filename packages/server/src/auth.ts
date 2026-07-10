import type { Context, MiddlewareHandler } from 'hono';
import { authenticateCredential, type Principal, type Role } from './users.js';

export type { Principal, Role } from './users.js';

const ROLE_POWER: Record<Role, number> = { guest: 0, viewer: 1, ci: 2, admin: 3, root: 4 };

function bearer(c: Context): string | undefined {
  const authorization = c.req.header('authorization');
  return authorization?.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : undefined;
}

export function hasRole(actual: Role, required: Role): boolean { return ROLE_POWER[actual] >= ROLE_POWER[required]; }

export async function principalFor(c: Context): Promise<Principal | undefined> {
  const token = bearer(c);
  return token ? authenticateCredential(token) : undefined;
}

export function requireRole(required: Role): MiddlewareHandler {
  return async (c, next) => {
    const principal = await principalFor(c);
    if (!principal || !hasRole(principal.role, required)) return c.json({ error: 'unauthorized' }, 401);
    c.set('principalRole', principal.role);
    c.set('principal', principal);
    await next();
  };
}
