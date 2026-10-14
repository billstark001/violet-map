import type { Context, MiddlewareHandler } from 'hono';
import type { Principal, Role } from './contracts.js';
import type { UserService } from './users.js';

const ROLE_POWER: Record<Role, number> = { guest: 0, viewer: 1, ci: 2, admin: 3, root: 4 };
export const REQUIRED_ROLE = {
  identity: 'viewer',
  diagnostics: 'viewer',
  worlds: 'ci',
  users: 'admin',
  data: 'admin',
} as const;

export function hasRole(actual: Role, required: Role): boolean {
  return ROLE_POWER[actual] >= ROLE_POWER[required];
}

export function bearer(c: Context): string | undefined {
  const authorization = c.req.header('authorization');
  return authorization?.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : undefined;
}

export function createAuthorization(service: UserService) {
  async function principalFor(c: Context): Promise<Principal | undefined> {
    const cached = c.get('principal') as Principal | undefined;
    if (cached) return cached;
    const token = bearer(c);
    return token ? service.authenticateCredential(token) : undefined;
  }
  function requireRole(required: Role): MiddlewareHandler {
    return async (c, next) => {
      const principal = await principalFor(c);
      if (!principal) return c.json({ code: 'UNAUTHENTICATED', error: 'a valid bearer credential is required' }, 401);
      if (!hasRole(principal.role, required))
        return c.json({ code: 'FORBIDDEN', error: `${required} role is required` }, 403);
      c.set('principalRole', principal.role);
      c.set('principal', principal);
      await next();
    };
  }
  return { principalFor, requireRole };
}
