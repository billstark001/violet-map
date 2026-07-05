import type { Context, MiddlewareHandler } from 'hono';
import { config } from './config.js';

export type Role = 'admin' | 'ci' | 'viewer';

interface Principal {
  token: string;
  role: Role;
}

const ROLE_POWER: Record<Role, number> = { viewer: 0, ci: 1, admin: 2 };

function parseTokens(): Principal[] {
  return config.adminTokens
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [token, role = 'admin'] = entry.split(':');
      return { token, role: (role === 'ci' || role === 'viewer' ? role : 'admin') as Role };
    })
    .filter((p) => p.token.length > 0);
}

const principals = parseTokens();

function bearer(c: Context): string | null {
  const auth = c.req.header('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return c.req.header('x-violet-admin-token') ?? null;
}

export function hasRole(actual: Role, required: Role): boolean {
  return ROLE_POWER[actual] >= ROLE_POWER[required];
}

export function requireRole(required: Role): MiddlewareHandler {
  return async (c, next) => {
    const token = bearer(c);
    const principal = token ? principals.find((p) => p.token === token) : null;
    if (!principal || !hasRole(principal.role, required)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('principalRole', principal.role);
    await next();
  };
}
