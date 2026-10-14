import type { RouteContext } from './context.js';
export function mountDiagnostics(context: RouteContext) {
  const { app, config, requireRole, MAX_DIAGNOSTIC_BYTES, randomUUID, fs, path, readLimitedBody, REQUIRED_ROLE } =
    context;
  app.post('/api/diagnostics', requireRole(REQUIRED_ROLE.diagnostics), async (c) => {
    const bytes = await readLimitedBody(c.req.raw, MAX_DIAGNOSTIC_BYTES);
    if (!bytes) {
      return c.json({ error: 'diagnostic payload too large' }, 413);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return c.json({ error: 'invalid diagnostic JSON' }, 400);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return c.json({ error: 'diagnostic payload must be an object' }, 400);
    }

    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    const dir = path.join(config.data.dir, 'diagnostics');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${id}.json`),
      JSON.stringify(
        {
          receivedAt: new Date().toISOString(),
          payload,
        },
        null,
        2,
      ),
      { encoding: 'utf8', flag: 'wx' },
    );
    return c.json({ ok: true, id });
  });
}
