import { requireStorageCapabilities } from '@violet-map/storage';
import { readRequestJson, RequestBodyError } from '../httpBody.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { bearer } from '../auth.js';
import type { RouteContext } from './context.js';

export function mountDiagnostics(context: RouteContext) {
  const { app, config, requireRole, MAX_DIAGNOSTIC_BYTES, randomUUID, fs, path, REQUIRED_ROLE } = context;
  const normalAuthorization = requireRole(REQUIRED_ROLE.diagnostics);
  app.post(
    '/api/diagnostics',
    async (c, next) => {
      const token = bearer(c);
      if (
        token &&
        config.auth.diagnosticsUploadToken &&
        timingSafeEqual(
          createHash('sha256').update(token).digest(),
          createHash('sha256').update(config.auth.diagnosticsUploadToken).digest(),
        )
      ) {
        await next();
        return;
      }
      return normalAuthorization(c, next);
    },
    async (c) => {
      let payload: unknown;
      try {
        payload = await readRequestJson(c, MAX_DIAGNOSTIC_BYTES);
      } catch (error) {
        if (!(error instanceof RequestBodyError)) throw error;
        return c.json(
          { error: error.reason === 'too-large' ? 'diagnostic payload too large' : 'invalid diagnostic JSON' },
          error.status,
        );
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return c.json({ error: 'diagnostic payload must be an object' }, 400);
      }

      const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
      const document = JSON.stringify({ receivedAt: new Date().toISOString(), payload }, null, 2);
      if (context.mounts.blobs)
        await requireStorageCapabilities(context.mounts.blobs, 'replace').replace(
          `diagnostics/${id}.json`,
          new TextEncoder().encode(document),
          'application/json',
        );
      else {
        const dir = path.join(config.data.dir, 'diagnostics');
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, `${id}.json`), document, { encoding: 'utf8', flag: 'wx' });
      }
      return c.json({ ok: true, id });
    },
  );
}
