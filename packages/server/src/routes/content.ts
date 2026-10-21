import { contentFailure } from '../contentErrors.js';
import { WorkLimiter } from '@violet-map/core/async';
import { readLimitedBody } from '@violet-map/core/http';
import { ContentValidationError, revisionTag } from '@violet-map/core/overlays';
import { mediaArtifact } from '@violet-map/core/resources';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import type { ServerConfig } from '../configuration.js';
import { ContentError } from '../content.js';
import { readRequestJson } from '../httpBody.js';
import { artifactResponse } from '../resourceHttp.js';
import type { AppServices } from '../serviceTypes.js';

function condition(c: Context): number | undefined {
  const value = c.req.header('if-match');
  if (value === undefined) return undefined;
  if (!/^"[1-9]\d*"$/.test(value)) throw new ContentValidationError('If-Match must be a quoted positive revision');
  const revision = Number(value.slice(1, -1));
  if (!Number.isSafeInteger(revision)) throw new ContentValidationError('invalid If-Match revision');
  return revision;
}

function documentResponse(c: Context, document: { revision: number }, created = false) {
  c.header('etag', revisionTag(document.revision));
  c.header('cache-control', 'no-store');
  if (!created && c.req.header('if-none-match') === revisionTag(document.revision)) return c.body(null, 304);
  return c.json(document, created ? 201 : 200);
}

export function mountContent(app: Hono, config: ServerConfig, services: AppServices): void {
  if (!config.features.contentReads || !services.content) return;
  const content = services.content;
  const routes = new Hono();
  routes.onError(contentFailure);
  routes.get('/api/maps/:id/media/:assetId/:versionId', async (c) => {
    const dimension = c.req.query('dimension');
    if (!dimension) throw new ContentValidationError('dimension is required');
    const { version, read } = await content.openPublicMedia(
      c.req.param('id'),
      dimension,
      c.req.param('assetId'),
      c.req.param('versionId'),
    );
    return artifactResponse(c, mediaArtifact(version), read);
  });
  if (config.features.adminApi) {
    routes.use('/api/admin/*', services.authorization.requireRole('ci'));
    routes.get('/api/admin/maps', async (c) =>
      c.json(
        await Promise.all(
          (await content.listMaps()).map(async (map) => ({ ...map, sourceStatus: await content.sourceStatus(map) })),
        ),
      ),
    );
    routes.get('/api/admin/maps/:id', async (c) => documentResponse(c, await content.getMap(c.req.param('id'))));
    routes.get('/api/admin/maps/:id/bindings', async (c) => {
      const map = await content.getMap(c.req.param('id'));
      c.header('etag', revisionTag(map.revision));
      return c.json(map.bindings);
    });
    routes.get('/api/admin/overlays/layers', async (c) => c.json(await content.listLayers()));
    routes.get('/api/admin/overlays/layers/:id', async (c) => {
      const revision = c.req.query('revision');
      return documentResponse(
        c,
        await content.getLayer(c.req.param('id'), revision === undefined ? undefined : Number(revision)),
      );
    });
    routes.get('/api/admin/overlays/layers/:id/revisions', async (c) => {
      const head = await content.getLayer(c.req.param('id'));
      return c.json({ layerId: head.layerId, revisions: Array.from({ length: head.revision }, (_, i) => i + 1) });
    });
    routes.get('/api/admin/media', async (c) => c.json(await content.listMedia()));
    routes.get('/api/admin/media/:id', async (c) => documentResponse(c, await content.getMedia(c.req.param('id'))));
    routes.get('/api/admin/media/:id/versions', async (c) => {
      const asset = await content.getMedia(c.req.param('id'));
      c.header('etag', revisionTag(asset.revision));
      return c.json(
        await Promise.all(asset.versions.map((version) => content.getMediaVersion(asset.assetId, version))),
      );
    });
    routes.get('/api/admin/media/:id/versions/:versionId', async (c) =>
      c.json(await content.getMediaVersion(c.req.param('id'), c.req.param('versionId'))),
    );
    routes.get('/api/admin/media/:id/versions/:versionId/file', async (c) => {
      const { version, read } = await content.openMedia(c.req.param('id'), c.req.param('versionId'));
      return artifactResponse(c, mediaArtifact(version), read);
    });
    if (config.features.contentWrites) {
      const mutations = new WorkLimiter(
        config.limits.contentMutations,
        config.limits.contentQueue,
        () => new ContentError('CONTENT_BUSY', 503, 'content mutation capacity is exhausted'),
      );
      const reserveMutation: MiddlewareHandler = (_c, next) => mutations.run(next);
      routes.post('/api/admin/maps', reserveMutation, async (c) =>
        documentResponse(c, await content.createMap(await readRequestJson(c, config.limits.uploadBytes)), true),
      );
      routes.put('/api/admin/maps/:id', reserveMutation, async (c) =>
        documentResponse(
          c,
          await content.replaceMap(
            c.req.param('id'),
            await readRequestJson(c, config.limits.uploadBytes),
            condition(c),
          ),
        ),
      );
      routes.delete('/api/admin/maps/:id', reserveMutation, async (c) => {
        await content.deleteMap(c.req.param('id'), condition(c));
        return c.json({ ok: true });
      });
      routes.put('/api/admin/maps/:id/bindings/:bindingId', reserveMutation, async (c) =>
        documentResponse(
          c,
          await content.setBinding(
            c.req.param('id'),
            c.req.param('bindingId'),
            await readRequestJson(c, config.limits.uploadBytes),
            condition(c),
          ),
        ),
      );
      routes.delete('/api/admin/maps/:id/bindings/:bindingId', reserveMutation, async (c) =>
        documentResponse(c, await content.setBinding(c.req.param('id'), c.req.param('bindingId'), null, condition(c))),
      );
      routes.post('/api/admin/overlays/layers', reserveMutation, async (c) =>
        documentResponse(c, await content.createLayer(await readRequestJson(c, config.limits.uploadBytes)), true),
      );
      routes.put('/api/admin/overlays/layers/:id', reserveMutation, async (c) =>
        documentResponse(
          c,
          await content.replaceLayer(
            c.req.param('id'),
            await readRequestJson(c, config.limits.uploadBytes),
            condition(c),
          ),
        ),
      );
      routes.post('/api/admin/overlays/layers/:id/copy', reserveMutation, async (c) => {
        const body = await readRequestJson(c, config.limits.uploadBytes);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => k !== 'name'))
          throw new ContentValidationError('copy accepts only a name');
        return documentResponse(c, await content.copyLayer(c.req.param('id'), (body as { name?: string }).name), true);
      });
      routes.delete('/api/admin/overlays/layers/:id', reserveMutation, async (c) => {
        await content.deleteLayer(c.req.param('id'), condition(c));
        return c.json({ ok: true });
      });
      const imports = new WorkLimiter(
        config.limits.mediaImports,
        config.limits.mediaQueue,
        () => new ContentError('CONTENT_BUSY', 503, 'media import capacity is exhausted'),
      );
      const upload = async (c: Context, id?: string) => {
        const expected = condition(c);
        if (id && expected === undefined) throw new ContentError('PRECONDITION_REQUIRED', 428, 'If-Match is required');
        const name = c.req.query('name');
        if (!name) throw new ContentValidationError('media name is required');
        // Reserve capacity before buffering the request or decoding pixels/GLB.
        return imports.run(async () => {
          const bytes = await readLimitedBody(c.req.raw, config.limits.uploadBytes);
          if (!bytes) return c.json({ code: 'PAYLOAD_TOO_LARGE', error: 'media exceeds upload limit' }, 413);
          const result = await content.importMedia(
            bytes,
            c.req.header('content-type')?.split(';')[0] ?? '',
            name,
            id,
            expected,
          );
          c.header('etag', revisionTag(result.document.revision));
          return c.json(result, id ? 200 : 201);
        });
      };
      routes.post('/api/admin/media', (c) => upload(c));
      routes.post('/api/admin/media/:id/versions', (c) => upload(c, c.req.param('id')));
      routes.delete('/api/admin/media/:id', reserveMutation, async (c) => {
        await content.deleteMedia(c.req.param('id'), condition(c));
        return c.json({ ok: true });
      });
      routes.delete('/api/admin/media/:id/versions/:versionId', reserveMutation, async (c) => {
        await content.deleteMedia(c.req.param('id'), condition(c), c.req.param('versionId'));
        return c.json({ ok: true });
      });
    }
  }
  app.route('/', routes);
}
