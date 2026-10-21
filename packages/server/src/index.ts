import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadServerConfig } from './configuration.js';
import { createServices } from './services.js';

const config = loadServerConfig({ env: process.env });
const services = await createServices(config);
let httpServer: ReturnType<typeof serve> | undefined;
let closing: Promise<void> | undefined;

function shutdown() {
  if (closing) return;
  closing = (async () => {
    try {
      if (httpServer?.listening) {
        const stopped = new Promise<void>((resolve, reject) =>
          httpServer!.close((error) => (error ? reject(error) : resolve())),
        );
        if ('closeIdleConnections' in httpServer) httpServer.closeIdleConnections();
        await stopped;
      }
    } finally {
      try {
        await services.close();
      } finally {
        if (process.connected) process.disconnect?.();
      }
    }
  })();
  void closing.catch((error) => {
    console.error('[violet-map] shutdown failed', error);
    process.exitCode = 1;
  });
}

process.once('SIGINT', shutdown);

process.once('SIGTERM', shutdown);

if (process.send)
  process.on('message', (message) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'violet-map:shutdown')
      shutdown();
  });

try {
  const application = createApp(config, services);
  if (config.server.staticDir) {
    const { serveStatic } = await import('@hono/node-server/serve-static');
    application.get('/api/*', (c) => c.notFound());
    application.get('/admin', (c) => c.redirect('/admin/'));
    application.use('*', async (c, next) => {
      if (
        c.req.path.endsWith('/index.html') ||
        c.req.path.endsWith('/runtime-config.json') ||
        c.req.path === '/' ||
        c.req.path === '/admin/'
      )
        c.header('cache-control', 'no-store');
      await next();
    });
    application.get('*', serveStatic({ root: config.server.staticDir }));
  }
  httpServer = serve({ fetch: application.fetch, port: config.server.port });
  await new Promise<void>((resolve, reject) => {
    httpServer!.once('error', reject);
    httpServer!.once('listening', resolve);
  });
  console.log('[violet-map] server on :' + config.server.port);
} catch (error) {
  await services.close();
  throw error;
}
