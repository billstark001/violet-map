import type { ServiceCapabilities } from '@violet-map/core/contracts';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ServerConfig } from './configuration.js';
import { mountAssets } from './routes/assets.js';
import { createAuthRoutes } from './routes/auth.js';
import { mountContent } from './routes/content.js';
import { createRouteContext } from './routes/context.js';
import { mountData } from './routes/data.js';
import { mountDataWrite } from './routes/dataWrite.js';
import { mountDiagnostics } from './routes/diagnostics.js';
import { mountPublicationProjections, mountResources } from './routes/resources.js';
import { createUserRoutes } from './routes/users.js';
import { mountWorldAdmin } from './routes/worldAdmin.js';
import { mountWorldRead } from './routes/worldRead.js';
import { mountWorldWrite } from './routes/worldWrite.js';
import type { AppServices } from './serviceTypes.js';

export function serviceCapabilities(config: ServerConfig): ServiceCapabilities {
  return {
    protocolVersion: 2,
    resourcesProtocol: 1,
    delivery: {
      mode: config.resources.delivery.mode,
      families: [
        'chunk',
        'texture',
        'atlas-image',
        'atlas-manifest',
        'asset-bundle',
        'game-data',
        'top-map-tile',
        ...(config.features.contentReads || config.resources.delivery.mode === 'public'
          ? ['overlay-media' as const]
          : []),
      ],
    },
    ...config.features,
    authMode: config.auth.mode,
  };
}

export function createApp(config: ServerConfig, services: AppServices) {
  const app = new Hono();
  app.use(
    '*',
    cors({
      origin: (origin) =>
        config.server.cors.origins.includes('*')
          ? '*'
          : config.server.cors.origins.includes(origin)
            ? origin
            : undefined,
      allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'Accept', 'Range', 'If-None-Match', 'If-Match', 'If-Range'],
      exposeHeaders: [
        'ETag',
        'Content-Range',
        'Accept-Ranges',
        'Retry-After',
        'Resource-Publication-State',
        'Resource-Publication-Revision',
      ],
      credentials: false,
    }),
  );
  app.use('/api/*', async (c, next) => {
    const path = c.req.path;
    const mutation =
      !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) &&
      !path.startsWith('/api/admin/resources/') &&
      (path.startsWith('/api/admin/worlds') ||
        path.startsWith('/api/admin/storage') ||
        path.startsWith('/api/data/') ||
        path === '/api/assets/reload' ||
        path.startsWith('/api/admin/maps') ||
        path.startsWith('/api/admin/overlays') ||
        path.startsWith('/api/admin/media'));
    if (!mutation) return next();
    if (/^\/api\/admin\/(?:maps|overlays|media)(?:\/|$)/.test(path)) await next();
    else await services.resources.mutateSource(next);
    if (config.resources.delivery.mode === 'public' && c.res.ok) {
      c.header('Resource-Publication-State', services.resources.state.publication);
      const revision = c.res.headers.get('etag') ?? c.req.header('if-match');
      if (revision) c.header('Resource-Publication-Revision', revision);
    }
  });
  app.get('/api/capabilities', (c) => c.json(serviceCapabilities(config)));
  mountResources(app, config, services);
  mountContent(app, config, services);
  if (config.resources.delivery.mode === 'public') mountPublicationProjections(app, services);
  if (services.assets && services.gameData && services.topMap && services.worldStore && services.mounts.worlds) {
    const context = createRouteContext(app, config, services);
    if (config.features.worldReads) mountWorldRead(context);
    mountAssets(context);
    mountData(context);
    if (config.features.adminApi) mountWorldAdmin(context);
    if (config.features.worldWrites) mountWorldWrite(context);
    if (config.features.dataWrites) mountDataWrite(context);
    if (config.features.diagnostics) mountDiagnostics(context);
  }
  if (config.features.users && services.users) {
    app.route('/', createAuthRoutes(services.users));
    if (config.features.adminApi) app.route('/', createUserRoutes(services.users));
  }
  return app;
}
