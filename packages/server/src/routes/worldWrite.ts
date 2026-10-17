import { bodyLimit } from 'hono/body-limit';
import { isDimensionId, isWorldName } from '@violet-map/core/domain';
import { isWorldCreateInput } from '../worldValidation.js';
import type { RouteContext } from './context.js';

export function mountWorldWrite(context: RouteContext) {
  const {
    app,
    config,
    worldStorage,
    createWorld,
    deleteChunks,
    deleteRegion,
    deleteWorld,
    invalidateStoredFile,
    saveChunkNbt,
    saveRegionFile,
    saveWorldFile,
    requireRole,
    adminStoragePath,
    REQUIRED_ROLE,
  } = context;
  app.put(
    '/api/admin/storage/files/*',
    requireRole(REQUIRED_ROLE.worlds),
    bodyLimit({ maxSize: config.limits.uploadBytes }),
    async (c) => {
      const dimension = c.req.param('dim');
      if (dimension && !isDimensionId(dimension)) return c.json({ error: 'invalid dimension id' }, 400);
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const filePath = adminStoragePath(c, 'files');
      await worldStorage.write(filePath, bytes, c.req.header('content-type') ?? undefined);
      invalidateStoredFile(filePath);
      return c.json({ ok: true });
    },
  );
  app.delete(
    '/api/admin/storage/files/*',
    requireRole(REQUIRED_ROLE.worlds),
    bodyLimit({ maxSize: config.limits.uploadBytes }),
    async (c) => {
      const dimension = c.req.param('dim');
      if (dimension && !isDimensionId(dimension)) return c.json({ error: 'invalid dimension id' }, 400);
      const filePath = adminStoragePath(c, 'files');
      await worldStorage.delete(filePath);
      invalidateStoredFile(filePath);
      return c.json({ ok: true });
    },
  );
  app.post(
    '/api/admin/worlds',
    requireRole(REQUIRED_ROLE.worlds),
    bodyLimit({ maxSize: config.limits.uploadBytes }),
    async (c) => {
      const dimension = c.req.param('dim');
      if (dimension && !isDimensionId(dimension)) return c.json({ error: 'invalid dimension id' }, 400);
      const body: unknown = await c.req.json().catch(() => null);
      if (!isWorldCreateInput(body) || !isWorldName(body.world))
        return c.json({ error: 'invalid world creation input' }, 400);
      return c.json(await createWorld(body.world, body.dimensions, body.levelName));
    },
  );
  app.post(
    '/api/admin/worlds/:world/create',
    requireRole(REQUIRED_ROLE.worlds),
    bodyLimit({ maxSize: config.limits.uploadBytes }),
    async (c) => {
      const dimension = c.req.param('dim');
      if (dimension && !isDimensionId(dimension)) return c.json({ error: 'invalid dimension id' }, 400);
      const raw = await c.req.text();
      let body: unknown = {};
      try {
        if (raw.trim()) body = JSON.parse(raw);
      } catch {
        return c.json({ error: 'invalid JSON' }, 400);
      }
      if (!isWorldCreateInput(body)) return c.json({ error: 'invalid world creation input' }, 400);
      return c.json(await createWorld(c.req.param('world'), body.dimensions, body.levelName));
    },
  );
  app.put(
    '/api/admin/worlds/:world/files/*',
    requireRole(REQUIRED_ROLE.worlds),
    bodyLimit({ maxSize: config.limits.uploadBytes }),
    async (c) => {
      const dimension = c.req.param('dim');
      if (dimension && !isDimensionId(dimension)) return c.json({ error: 'invalid dimension id' }, 400);
      const world = c.req.param('world');
      const relativePath = decodeURIComponent(c.req.path.replace(/^\/api\/admin\/worlds\/[^/]+\/files\//, ''));
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      return c.json(await saveWorldFile(world, relativePath, bytes));
    },
  );
  app.post(
    '/api/admin/worlds/:world/files',
    requireRole(REQUIRED_ROLE.worlds),
    bodyLimit({ maxSize: config.limits.uploadBytes }),
    async (c) => {
      const dimension = c.req.param('dim');
      if (dimension && !isDimensionId(dimension)) return c.json({ error: 'invalid dimension id' }, 400);
      const body = await c.req.parseBody();
      const file = body.file;
      const relativePath = String(body.path || (file instanceof File ? file.name : ''));
      if (!(file instanceof File)) return c.json({ error: 'missing file' }, 400);
      return c.json(await saveWorldFile(c.req.param('world'), relativePath, new Uint8Array(await file.arrayBuffer())));
    },
  );
  app.delete('/api/admin/worlds/:world', requireRole(REQUIRED_ROLE.worlds), async (c) =>
    c.json(await deleteWorld(c.req.param('world'))),
  );
  app.delete(
    '/api/admin/worlds/:world/:dim/regions/:rx/:rz',
    requireRole(REQUIRED_ROLE.worlds),
    bodyLimit({ maxSize: config.limits.uploadBytes }),
    async (c) => {
      const dimension = c.req.param('dim');
      if (dimension && !isDimensionId(dimension)) return c.json({ error: 'invalid dimension id' }, 400);
      const rx = Number(c.req.param('rx')),
        rz = Number(c.req.param('rz'));
      if (!Number.isInteger(rx) || !Number.isInteger(rz)) return c.json({ error: 'bad region coords' }, 400);
      return c.json(await deleteRegion(c.req.param('world'), c.req.param('dim'), rx, rz));
    },
  );
  app.delete(
    '/api/admin/worlds/:world/:dim/chunks',
    requireRole(REQUIRED_ROLE.worlds),
    bodyLimit({ maxSize: config.limits.uploadBytes }),
    async (c) => {
      const dimension = c.req.param('dim');
      if (dimension && !isDimensionId(dimension)) return c.json({ error: 'invalid dimension id' }, 400);
      const body = await c.req.json<{ chunks?: { cx: number; cz: number }[] }>();
      return c.json(
        await deleteChunks(c.req.param('world'), c.req.param('dim'), Array.isArray(body.chunks) ? body.chunks : []),
      );
    },
  );
  app.post(
    '/api/admin/worlds/:world/upload',
    requireRole(REQUIRED_ROLE.worlds),
    bodyLimit({ maxSize: config.limits.uploadBytes }),
    async (c) => {
      const dimension = c.req.param('dim');
      if (dimension && !isDimensionId(dimension)) return c.json({ error: 'invalid dimension id' }, 400);
      const body = await c.req.parseBody();
      const file = body.file;
      if (!(file instanceof File)) return c.json({ error: 'missing file' }, 400);
      const world = c.req.param('world');
      const dim = String(body.dim || 'minecraft:overworld');
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        if (file.name.endsWith('.mca')) {
          await saveRegionFile(world, dim, file.name, bytes);
          return c.json({ ok: true, type: 'region', name: file.name });
        }
        const pos = await saveChunkNbt(world, dim, bytes);
        return c.json({ ok: true, type: 'chunk', ...pos });
      } catch (e) {
        return c.json({ error: (e as Error).message }, 400);
      }
    },
  );
}
