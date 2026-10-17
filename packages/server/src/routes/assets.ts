import { nonSharedByteView } from '@violet-map/core/http';
import type { RouteContext } from './context.js';

export function mountAssets(context: RouteContext) {
  const {
    app,
    buildTextureAtlas,
    getAssetBundlePayload,
    getTextureAtlasPng,
    readTextureFile,
    MAX_ATLAS_TEXTURES,
    MAX_ATLAS_REQUEST_BYTES,
    jsonPayload,
    readLimitedBody,
  } = context;
  app.get('/api/assets/bundle', async (c) =>
    jsonPayload(c, await getAssetBundlePayload(), 'public, max-age=300, must-revalidate'),
  );
  app.post('/api/assets/atlas', async (c) => {
    const bytes = await readLimitedBody(c.req.raw, MAX_ATLAS_REQUEST_BYTES);
    if (!bytes) return c.json({ error: 'request body too large' }, 413);
    let body: { ids?: unknown };
    try {
      body = JSON.parse(new TextDecoder().decode(bytes)) as { ids?: unknown };
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }
    if (!Array.isArray(body.ids)) return c.json({ error: 'ids must be an array' }, 400);
    if (body.ids.length > MAX_ATLAS_TEXTURES)
      return c.json({ error: `at most ${MAX_ATLAS_TEXTURES} texture ids are allowed` }, 413);
    const ids: string[] = [];
    for (const id of body.ids) {
      if (typeof id !== 'string' || id.length > 200 || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id) || id.includes('..')) {
        return c.json({ error: 'invalid texture id' }, 400);
      }
      ids.push(id);
    }
    try {
      const { manifest } = await buildTextureAtlas(ids);
      return c.json(manifest, 200, { 'cache-control': 'public, max-age=300, must-revalidate' });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.get('/api/assets/atlas/:key', async (c) => {
    const key = c.req.param('key');
    if (!key) return c.text('atlas not found', 404);
    const png = getTextureAtlasPng(key);
    if (!png) return c.text('atlas not found', 404);
    return c.body(nonSharedByteView(png), 200, {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=300, must-revalidate',
    });
  });
  app.get('/api/assets/texture/*', async (c) => {
    let id: string;
    try {
      id = decodeURIComponent(c.req.path.replace('/api/assets/texture/', ''));
    } catch {
      return c.text('invalid texture id', 400);
    }
    const texture = await readTextureFile(id);
    if (!texture) return c.text('texture not found', 404);
    const headers = {
      etag: texture.etag,
      'content-type': 'image/png',
      'cache-control': 'public, max-age=3600, must-revalidate',
    };
    if (c.req.header('if-none-match') === texture.etag) return c.body(null, 304, headers);
    return c.body(nonSharedByteView(texture.bytes), 200, {
      ...headers,
    });
  });
}
