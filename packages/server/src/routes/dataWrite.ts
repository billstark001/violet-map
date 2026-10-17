import { parseBiomeMap } from '@violet-map/core/domain';
import { readRequestJson } from '../httpBody.js';
import type { RouteContext } from './context.js';

export function mountDataWrite(context: RouteContext) {
  const {
    app,
    config,
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
    const body = await readRequestJson(c, config.limits.uploadBytes);
    try {
      parseBiomeMap(body);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'invalid biomes' }, 400);
    }
    await writeDataFile('biomes.json', body);
    return c.json({ ok: true });
  });
}
