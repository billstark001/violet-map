import type { RouteContext } from './context.js';

export function mountDataWrite(context: RouteContext) {
  const {
    app,
    buildAssetBundle,
    clearTextureAtlasCache,
    clearGameDataCaches,
    writeDataFile,
    requireRole,
    REQUIRED_ROLE,
  } = context;
  app.post('/api/assets/reload', requireRole(REQUIRED_ROLE.data), async (c) => {
    await buildAssetBundle(true);
    clearTextureAtlasCache();
    clearGameDataCaches();
    return c.json({ ok: true });
  });
  app.put('/api/data/biomes', requireRole(REQUIRED_ROLE.data), async (c) => {
    await writeDataFile('biomes.json', await c.req.json());
    return c.json({ ok: true });
  });
}
