import type { RouteContext } from './context.js';
import { readRequestJson } from '../httpBody.js';
import { isWorldDiffInput, validateWorldName } from '../worldValidation.js';

export function mountWorldAdmin(context: RouteContext) {
  context.app.use('/api/admin/worlds/:world/*', validateWorldName);
  context.app.use('/api/admin/worlds/:world', validateWorldName);
  const {
    app,
    config,
    worldStorage,
    diffWorldManifest,
    worldManifest,
    requireRole,
    adminStoragePath,
    parseByteRange,
    REQUIRED_ROLE,
  } = context;
  app.get('/api/admin/storage/list', requireRole(REQUIRED_ROLE.worlds), async (c) =>
    c.json(await worldStorage.list(c.req.query('prefix') ?? '')),
  );
  app.get('/api/admin/storage/directories', requireRole(REQUIRED_ROLE.worlds), async (c) =>
    c.json(await worldStorage.listDirectories(c.req.query('prefix') ?? '')),
  );
  app.get('/api/admin/storage/stat/*', requireRole(REQUIRED_ROLE.worlds), async (c) => {
    const info = await worldStorage.stat(adminStoragePath(c, 'stat'));
    return info ? c.json(info) : c.json({ error: 'not found' }, 404);
  });
  app.get('/api/admin/storage/files/*', requireRole(REQUIRED_ROLE.worlds), async (c) => {
    const filePath = adminStoragePath(c, 'files');
    const info = await worldStorage.stat(filePath);
    if (!info) return c.json({ error: 'not found' }, 404);
    const rangeHeader = c.req.header('range');
    const range = rangeHeader === undefined ? null : parseByteRange(rangeHeader, info.size);
    if (rangeHeader !== undefined && !range)
      return c.body(null, 416, { 'content-range': `bytes */${info.size}`, 'accept-ranges': 'bytes' });
    const bytes = range
      ? await worldStorage.readRange(filePath, range.start, range.end - range.start + 1)
      : await worldStorage.read(filePath);
    if (!bytes) return c.json({ error: 'not found' }, 404);
    if (range && bytes.byteLength === 0) {
      const latest = await worldStorage.stat(filePath);
      return c.body(null, 416, {
        'content-range': `bytes */${latest?.size ?? info.size}`,
        'accept-ranges': 'bytes',
      });
    }
    const responseBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return c.body(
      responseBytes,
      range ? 206 : 200,
      range
        ? {
            'content-range': `bytes ${range.start}-${range.start + bytes.byteLength - 1}/${info.size}`,
            'accept-ranges': 'bytes',
          }
        : undefined,
    );
  });
  app.get('/api/admin/worlds/:world/manifest', requireRole(REQUIRED_ROLE.worlds), async (c) =>
    c.json({
      world: c.req.param('world'),
      files: await worldManifest(c.req.param('world')),
    }),
  );
  app.post('/api/admin/worlds/:world/diff', requireRole(REQUIRED_ROLE.worlds), async (c) => {
    const body = await readRequestJson(c, config.limits.uploadBytes);
    if (!isWorldDiffInput(body)) return c.json({ error: 'invalid world manifest' }, 400);
    return c.json(await diffWorldManifest(c.req.param('world'), body.files ?? []));
  });
}
