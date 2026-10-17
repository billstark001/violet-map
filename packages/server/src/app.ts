import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ServiceCapabilities } from '@violet-map/core/contracts';
import type { ServerConfig } from './configuration.js';
import type { AppServices } from './serviceTypes.js';
import { createRouteContext } from './routes/context.js';
import { createAuthRoutes } from './routes/auth.js';
import { createUserRoutes } from './routes/users.js';
import { mountWorldRead } from './routes/worldRead.js';
import { mountWorldAdmin } from './routes/worldAdmin.js';
import { mountWorldWrite } from './routes/worldWrite.js';
import { mountAssets } from './routes/assets.js';
import { mountData } from './routes/data.js';
import { mountDataWrite } from './routes/dataWrite.js';
import { mountContent } from './routes/content.js';
import { mountDiagnostics } from './routes/diagnostics.js';

export function serviceCapabilities(config: ServerConfig): ServiceCapabilities {
  return { protocolVersion: 1, ...config.features, authMode: config.auth.mode };
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
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type', 'Accept', 'Range', 'If-None-Match', 'If-Match'],
      exposeHeaders: ['ETag', 'Content-Range', 'Accept-Ranges', 'Retry-After'],
      credentials: false,
    }),
  );
  app.get('/api/capabilities', (c) => c.json(serviceCapabilities(config)));
  const context = createRouteContext(app, config, services);
  mountWorldRead(context);
  mountContent(app, config, services);
  mountAssets(context);
  mountData(context);
  if (config.features.adminApi) mountWorldAdmin(context);
  if (config.features.worldWrites) mountWorldWrite(context);
  if (config.features.dataWrites) mountDataWrite(context);
  if (config.features.diagnostics) mountDiagnostics(context);
  if (config.features.users && services.users) {
    app.route('/', createAuthRoutes(services.users));
    if (config.features.adminApi) app.route('/', createUserRoutes(services.users));
  }
  return app;
}
