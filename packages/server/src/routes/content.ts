import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { ContentValidationError, revisionTag } from '@violet-map/core/overlays';
import { ContentError, type PublishedMedia } from '../content.js';
import type { ServerConfig } from '../configuration.js';
import type { AppServices } from '../serviceTypes.js';
import { nonSharedByteView, readLimitedBody } from '@violet-map/core/http';
import { parseByteRange } from '../httpRange.js';
import { createHash } from 'node:crypto';
import fresh from 'fresh';
import { WorkLimiter } from '@violet-map/core/async';

function condition(c: Context): number | undefined {
  const value = c.req.header('if-match');
  if (value === undefined) return undefined;
  if (!/^"[1-9]\d*"$/.test(value)) throw new ContentValidationError('If-Match must be a quoted positive revision');
  const revision = Number(value.slice(1, -1));
  if (!Number.isSafeInteger(revision)) throw new ContentValidationError('invalid If-Match revision');
  return revision;
}

async function jsonBody(c: Context, limit: number): Promise<unknown> {
  const bytes = await readLimitedBody(c.req.raw, limit);
  if (!bytes) throw new ContentError('PAYLOAD_TOO_LARGE', 413, 'content document exceeds upload limit');
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ContentValidationError('invalid JSON');
  }
}

function documentResponse(c: Context, document: { revision: number }, created = false) {
  c.header('etag', revisionTag(document.revision));
  c.header('cache-control', 'no-store');
  if (!created && c.req.header('if-none-match') === revisionTag(document.revision)) return c.body(null, 304);
  return c.json(document, created ? 201 : 200);
}

async function bytesResponse(c: Context, { version, read }: PublishedMedia) {
  const etag = `"${version.digest}"`;
  const headers = {
    etag,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=0, must-revalidate',
    'content-type': version.mediaType,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'none'; sandbox",
  };
  if (
    fresh({ 'if-none-match': c.req.header('if-none-match'), 'cache-control': c.req.header('cache-control') }, { etag })
  )
    return c.body(null, 304, headers);
  const ifRange = c.req.header('if-range');
  const header =
    c.req.method === 'GET' && (ifRange === undefined || ifRange === etag) ? c.req.header('range') : undefined;
  const range = header === undefined ? undefined : parseByteRange(header, version.bytes);
  if (header !== undefined && !range)
    return c.body(null, 416, { ...headers, 'content-range': `bytes */${version.bytes}` });
  if (c.req.method === 'HEAD') return c.body(null, 200, { ...headers, 'content-length': String(version.bytes) });
  const body = await read(range ?? undefined);
  return c.body(nonSharedByteView(body), range ? 206 : 200, {
    ...headers,
    'content-length': String(body.byteLength),
    ...(range ? { 'content-range': `bytes ${range.start}-${range.end}/${version.bytes}` } : {}),
  });
}

export function mountContent(app: Hono, config: ServerConfig, services: AppServices): void {
  if (!config.features.contentReads || !services.content) return;
  const content = services.content;
  const routes = new Hono();
  routes.onError((error, c) => {
    if (error instanceof ContentValidationError)
      return c.json({ code: error.code, error: error.message }, error.code === 'UNSUPPORTED_FORMAT' ? 415 : 400);
    if (error instanceof ContentError) {
      if (error.code === 'CONTENT_BUSY') c.header('retry-after', '1');
      return c.json({ code: error.code, error: error.message }, error.status);
    }
    // Backend errors may include endpoint URLs and credentials. Never reflect them.
    return c.json({ code: 'CONTENT_BACKEND_UNAVAILABLE', error: 'content backend is unavailable' }, 503);
  });
  routes.get('/api/maps/:id/overlays', async (c) => {
    const dimension = c.req.query('dimension');
    if (!dimension) throw new ContentValidationError('dimension is required');
    const delivery = c.req.query('delivery') ?? 'proxy';
    if (delivery !== 'proxy' && delivery !== 'public')
      throw new ContentValidationError('delivery must be proxy or public');
    const manifest = await content.manifest(c.req.param('id'), dimension, delivery);
    const body = JSON.stringify(manifest);
    const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
    c.header('etag', etag);
    c.header('cache-control', 'no-cache');
    if (c.req.header('if-none-match') === etag) return c.body(null, 304);
    return c.body(body, 200, { 'content-type': 'application/json' });
  });
  routes.get('/api/maps/:id/media/:assetId/:versionId', async (c) => {
    const dimension = c.req.query('dimension');
    if (!dimension) throw new ContentValidationError('dimension is required');
    return bytesResponse(
      c,
      await content.openPublicMedia(c.req.param('id'), dimension, c.req.param('assetId'), c.req.param('versionId')),
    );
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
    routes.get('/api/admin/media/:id/versions/:versionId/file', async (c) =>
      bytesResponse(c, await content.openMedia(c.req.param('id'), c.req.param('versionId'))),
    );
    if (config.features.contentWrites) {
      const mutations = new WorkLimiter(
        config.limits.contentMutations,
        config.limits.contentQueue,
        () => new ContentError('CONTENT_BUSY', 503, 'content mutation capacity is exhausted'),
      );
      const reserveMutation: MiddlewareHandler = (_c, next) => mutations.run(next);
      routes.post('/api/admin/maps', reserveMutation, async (c) =>
        documentResponse(c, await content.createMap(await jsonBody(c, config.limits.uploadBytes)), true),
      );
      routes.put('/api/admin/maps/:id', reserveMutation, async (c) =>
        documentResponse(
          c,
          await content.replaceMap(c.req.param('id'), await jsonBody(c, config.limits.uploadBytes), condition(c)),
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
            await jsonBody(c, config.limits.uploadBytes),
            condition(c),
          ),
        ),
      );
      routes.delete('/api/admin/maps/:id/bindings/:bindingId', reserveMutation, async (c) =>
        documentResponse(c, await content.setBinding(c.req.param('id'), c.req.param('bindingId'), null, condition(c))),
      );
      routes.post('/api/admin/overlays/layers', reserveMutation, async (c) =>
        documentResponse(c, await content.createLayer(await jsonBody(c, config.limits.uploadBytes)), true),
      );
      routes.put('/api/admin/overlays/layers/:id', reserveMutation, async (c) =>
        documentResponse(
          c,
          await content.replaceLayer(c.req.param('id'), await jsonBody(c, config.limits.uploadBytes), condition(c)),
        ),
      );
      routes.post('/api/admin/overlays/layers/:id/copy', reserveMutation, async (c) => {
        const body = await jsonBody(c, config.limits.uploadBytes);
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
