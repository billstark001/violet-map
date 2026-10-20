import { artifactResponse } from '../resourceHttp.js';
import { resourceFailure } from '../resourceErrors.js';
import type { RouteContext } from './context.js';

export function mountAssets(context: RouteContext) {
  const { app, MAX_ATLAS_TEXTURES, MAX_ATLAS_REQUEST_BYTES, readLimitedBody } = context;
  app.get('/api/assets/bundle', async (c) => {
    try {
      const body = await context.resources.businessResource({ kind: 'asset-bundle' });
      return body ? artifactResponse(c, body.artifact, body.read) : c.json({ error: 'bundle not found' }, 404);
    } catch (error) {
      return resourceFailure(error as Error, c);
    }
  });
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
      const manifest = await context.resources.atlas(ids);
      return c.json(manifest, 200, { 'cache-control': 'public, max-age=300, must-revalidate' });
    } catch (error) {
      return resourceFailure(error as Error, c);
    }
  });
  app.get('/api/assets/texture/*', async (c) => {
    let id: string;
    try {
      id = decodeURIComponent(c.req.path.replace('/api/assets/texture/', ''));
    } catch {
      return c.text('invalid texture id', 400);
    }
    try {
      const texture = await context.resources.businessResource({ kind: 'texture', id });
      return texture ? artifactResponse(c, texture.artifact, texture.read) : c.text('texture not found', 404);
    } catch (error) {
      return resourceFailure(error as Error, c);
    }
  });
}
