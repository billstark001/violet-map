import { createHash, timingSafeEqual } from 'node:crypto';
import type { Authentication } from './auth.js';
import type { ServerConfig } from './configuration.js';
export function createAuthentication(auth: ServerConfig['auth']): Authentication {
  const expected = auth.staticToken ? createHash('sha256').update(auth.staticToken).digest() : undefined;
  return {
    authenticateCredential: async (token) => {
      if (auth.mode !== 'static' || !expected) return undefined;
      const actual = createHash('sha256').update(token).digest();
      return timingSafeEqual(actual, expected)
        ? { id: 'static', username: 'service', role: auth.staticRole, source: 'static' }
        : undefined;
    },
  };
}
