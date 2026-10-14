import { serve } from '@hono/node-server';
import { loadServerConfig } from './configuration.js';
import { createServices } from './services.js';
import { createApp } from './app.js';
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
      await services.close();
    }
  })();
  void closing.catch((error) => {
    console.error('[violet-map] shutdown failed', error);
    process.exitCode = 1;
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
try {
  httpServer = serve({ fetch: createApp(config, services).fetch, port: config.server.port });
  await new Promise<void>((resolve, reject) => {
    httpServer!.once('error', reject);
    httpServer!.once('listening', resolve);
  });
  console.log('[violet-map] server on :' + config.server.port);
  if (config.cache.prewarm) {
    void services.assets.buildAssetBundle().catch((error) => console.error('[violet-map] asset warmup failed', error));
    void services.topMap
      .warmTopMapManifests()
      .catch((error) => console.error('[violet-map] top-map warmup failed', error));
  }
} catch (error) {
  await services.close();
  throw error;
}
