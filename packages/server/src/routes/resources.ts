import { contentFailure } from '../contentErrors.js';
import { validateWorldName } from '../worldValidation.js';
import { isDimensionId } from '@violet-map/core/domain';
import { resourceFailure } from '../resourceErrors.js';
import { readRequestJson } from '../httpBody.js';
import { ContentValidationError } from '@violet-map/core/overlays';
import { parseResourceSelector, type ResourceKind } from '@violet-map/core/resources';
import { sha256 } from '@violet-map/storage';
import { parsePublicationManifest } from '@violet-map/resources';
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
      const value = await readRequestJson(c, config.limits.chunkRequestBytes);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid resolve request');
      const body = value as Record<string, unknown>;
      if (
        Object.keys(body).some((k) => !['viewId', 'selectors'].includes(k)) ||
        typeof body.viewId !== 'string' ||
        !Array.isArray(body.selectors) ||
        body.selectors.length > 128
      )
        throw new TypeError('resolve requires viewId and at most 128 selectors');
      const resolved = await resources.resolve(
        body.viewId,
        body.selectors.map(parseResourceSelector),
        c.req.raw.signal,
      );
      return c.json(resolved, 200, {
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
  if ((config.features.contentReads && services.content) || config.resources.delivery.mode === 'public')
    routes.get('/api/maps/:id/overlays', async (c) => {
      try {
        const dimension = c.req.query('dimension'),
          viewId = c.req.query('viewId');
        // This documented business endpoint keeps its content API validation envelope.
        if (!dimension || !viewId || c.req.query('delivery') !== undefined) {
          const error = new ContentValidationError(
            !dimension
              ? 'dimension is required'
              : !viewId
                ? 'viewId is required'
                : 'delivery was removed; resource mode is selected by the server',
          );
          throw error;
        }
        const body = JSON.stringify(await resources.overlays(c.req.param('id'), dimension, viewId));
        const etag = `"${sha256(body)}"`;
        c.header('etag', etag);
        c.header('cache-control', 'no-cache');
        if (c.req.header('if-none-match') === etag) return c.body(null, 304);
        return c.body(body, 200, { 'content-type': 'application/json' });
      } catch (error) {
        return contentFailure(error as Error, c);
      }
    });
  if (config.features.adminApi) {
    routes.use('/api/admin/resources/*', services.authorization.requireRole('ci'));
    if (config.resources.roles.includes('publish'))
      routes.post('/api/admin/resources/publications', async (c) => {
        const body = (await readRequestJson(c, Math.floor(config.resources.cache.metadataBytes / 4) + 4096)) as Record<
          string,
          unknown
        >;
        if (
          !body ||
          typeof body !== 'object' ||
          Object.keys(body).some((k) => !['expectedHead', 'prepared'].includes(k)) ||
          !('expectedHead' in body) ||
          (body.expectedHead !== null &&
            (typeof body.expectedHead !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedHead)))
        )
          throw new TypeError('publication requires expectedHead');
        return c.json(
          await resources.publication.publish(
            body.expectedHead,
            body.prepared === undefined ? undefined : parsePublicationManifest(body.prepared),
          ),
        );
      });
    if (config.resources.roles.includes('publish')) {
      routes.post('/api/admin/resources/readiness', async (c) => {
        const value = await readRequestJson(c, config.limits.chunkRequestBytes);
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new TypeError('invalid readiness request');
        const body = value as Record<string, unknown>;
        if (
          Object.keys(body).some((key) => !['expectedHead', 'world', 'selectors'].includes(key)) ||
          !('expectedHead' in body) ||
          (body.expectedHead !== null &&
            (typeof body.expectedHead !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedHead))) ||
          (body.world !== undefined && typeof body.world !== 'string') ||
          (body.selectors !== undefined && (!Array.isArray(body.selectors) || body.selectors.length > 128))
        )
          throw new TypeError('readiness requires expectedHead and at most 128 selectors');
        const task = resources.publication.start(
          body.expectedHead as string | null,
          (body.selectors as unknown[] | undefined)?.map(parseResourceSelector),
          body.world as string | undefined,
        );
        return c.json(task, task.state === 'pending' ? 202 : 200, {
          'cache-control': 'no-store',
          location: `/api/admin/resources/readiness/${task.id}`,
        });
      });
      routes.get('/api/admin/resources/readiness/:id', (c) =>
        c.json(resources.publication.taskStatus(c.req.param('id')), 200, { 'cache-control': 'no-store' }),
      );
      routes.post('/api/admin/resources/prepare', async (c) => c.json(await resources.publication.prepare()));
      routes.post('/api/admin/resources/verify', async (c) => c.json(await resources.publication.verify()));
      routes.post('/api/admin/resources/gc', async (c) => c.json(await resources.publication.gc()));
      routes.post('/api/admin/resources/reindex', async (c) =>
        c.json({
          originals: services.content ? await services.content.verifyRetainedMedia() : 0,
          actions: await resources.publication.reindex(),
        }),
      );
    }
    routes.get('/api/admin/resources/status', async (c) => c.json(await resources.status()));
  }
  app.route('/', routes);
}

/** Business projections share the same view and snapshot rules in every delivery mode. */
export function mountResourceProjections(app: Hono, services: AppServices) {
  const resources = services.resources;
  const routes = new Hono();
  routes.onError(resourceFailure);
  routes.use('/api/worlds/:world/*', validateWorldName);
  routes.use('/api/worlds/:world/:dim/*', async (c, next) => {
    if (!isDimensionId(c.req.param('dim'))) return c.json({ error: 'invalid dimension id' }, 400);
    await next();
  });
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
  app.route('/', routes);
}
