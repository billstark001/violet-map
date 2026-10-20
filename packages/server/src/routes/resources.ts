import { resourceFailure } from '../resourceErrors.js';
import { readLimitedBody } from '@violet-map/core/http';
import { parseResourceSelector, type ResourceKind } from '@violet-map/core/resources';
import { sha256 } from '@violet-map/storage';
import { Hono } from 'hono';
import type { ServerConfig } from '../configuration.js';
import { artifactResponse } from '../resourceHttp.js';
import type { AppServices } from '../serviceTypes.js';

export function mountResources(app: Hono, config: ServerConfig, services: AppServices) {
  const routes = new Hono();
  const resources = services.resources;
  routes.onError(resourceFailure);
  if (config.resources.roles.includes('serve')) {
    routes.get('/api/resources/views/current', async (c) => {
      const head = await resources.head(c.req.query('world'));
      const body = JSON.stringify(head);
      const etag = `"${sha256(body)}"`;
      if (c.req.header('if-none-match') === etag) return c.body(null, 304, { etag: etag, 'cache-control': 'no-cache' });
      return c.body(body, 200, { 'content-type': 'application/json', etag: etag, 'cache-control': 'no-cache' });
    });
    routes.post('/api/resources/resolve', async (c) => {
      const bytes = await readLimitedBody(c.req.raw, config.limits.chunkRequestBytes);
      if (!bytes)
        return c.json({ code: 'INVALID_INPUT', message: 'resource request exceeds limits', retryable: false }, 413);
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new TypeError('invalid resource JSON');
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid resolve request');
      const body = value as Record<string, unknown>;
      if (
        Object.keys(body).some((k) => !['viewId', 'selectors'].includes(k)) ||
        typeof body.viewId !== 'string' ||
        !Array.isArray(body.selectors) ||
        body.selectors.length > 128
      )
        throw new TypeError('resolve requires viewId and at most 128 selectors');
      return c.json(await resources.resolve(body.viewId, body.selectors.map(parseResourceSelector)), 200, {
        'cache-control': 'no-store',
      });
    });
    if (config.resources.delivery.mode === 'server')
      routes.on(['GET', 'HEAD'], '/api/resources/:viewId/:kind/:digest', async (c) => {
        const object = await resources.open(
          c.req.param('viewId'),
          c.req.param('kind') as ResourceKind,
          c.req.param('digest'),
        );
        return artifactResponse(c, object.artifact, object.read);
      });
  }
  if (config.features.adminApi) {
    routes.use('/api/admin/resources/*', services.authorization.requireRole('ci'));
    if (config.resources.roles.includes('publish'))
      routes.post('/api/admin/resources/publications', async (c) => {
        const bytes = await readLimitedBody(c.req.raw, 4096);
        if (!bytes) throw new RangeError('publication request exceeds limits');
        const body = JSON.parse(new TextDecoder().decode(bytes));
        if (
          !body ||
          typeof body !== 'object' ||
          Object.keys(body).some((k) => k !== 'expectedHead') ||
          !('expectedHead' in body) ||
          (body.expectedHead !== null &&
            (typeof body.expectedHead !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedHead)))
        )
          throw new TypeError('publication requires expectedHead');
        return c.json(await resources.publish(body.expectedHead));
      });
    if (config.resources.roles.includes('publish')) {
      routes.post('/api/admin/resources/prepare', async (c) => c.json(await resources.prepare()));
      routes.post('/api/admin/resources/verify', async (c) => c.json(await resources.verify()));
      routes.post('/api/admin/resources/gc', async (c) => c.json(await resources.gc()));
      routes.post('/api/admin/resources/reindex', async (c) =>
        c.json({
          originals: services.content ? await services.content.verifyRetainedMedia() : 0,
          actions: await resources.reindex(),
        }),
      );
    }
    routes.get('/api/admin/resources/status', async (c) => c.json(await resources.status()));
  }
  app.route('/', routes);
}

/** Public reader projections depend exclusively on the committed publication. */
export function mountPublicationProjections(app: Hono, services: AppServices) {
  const resources = services.resources;
  const routes = new Hono();
  routes.onError(resourceFailure);
  routes.get('/api/worlds', async (c) => c.json(await resources.worlds()));
  routes.get('/api/worlds/:world/capabilities', async (c) =>
    c.json(await resources.worldCapabilities(c.req.param('world'), c.req.query('viewId'))),
  );
  routes.get('/api/worlds/:world/:dim/chunk-coverage', async (c) =>
    c.json(await resources.coverage(c.req.param('world'), c.req.param('dim'), c.req.query('viewId'))),
  );
  routes.get('/api/worlds/:world/:dim/regions', async (c) =>
    c.json(
      (await resources.coverage(c.req.param('world'), c.req.param('dim'), c.req.query('viewId'))).regions.map(
        ({ x, z }) => ({ x, z }),
      ),
    ),
  );
  routes.get('/api/worlds/:world/:dim/top-map/manifest', async (c) => {
    const manifest = await resources.topMap(c.req.param('world'), c.req.param('dim'), c.req.query('viewId'));
    return manifest
      ? c.json(manifest)
      : c.json({ code: 'RESOURCE_NOT_PUBLISHED', message: 'top map is not published', retryable: false }, 404);
  });
  if (!services.content)
    routes.get('/api/maps/:id/overlays', async (c) => {
      const dimension = c.req.query('dimension'),
        viewId = c.req.query('viewId');
      if (!dimension || !viewId)
        return c.json({ code: 'INVALID_INPUT', message: 'dimension and viewId are required', retryable: false }, 400);
      return c.json(await resources.overlays(c.req.param('id'), dimension, viewId));
    });
  app.route('/', routes);
}
