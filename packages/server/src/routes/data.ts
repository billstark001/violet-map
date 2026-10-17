import type { RouteContext } from './context.js';

export function mountData(context: RouteContext) {
  const { app, buildBlockInfo, readBiomes, readDimensions, jsonPayload, cachedObjectPayload } = context;
  app.get('/api/data/blocks', async (c) =>
    jsonPayload(c, cachedObjectPayload(await buildBlockInfo()), 'public, max-age=60, must-revalidate'),
  );
  app.get('/api/data/biomes', async (c) =>
    jsonPayload(c, cachedObjectPayload(await readBiomes()), 'public, max-age=60, must-revalidate'),
  );
  app.get('/api/data/dimensions', async (c) =>
    jsonPayload(c, cachedObjectPayload(await readDimensions()), 'public, max-age=60, must-revalidate'),
  );
}
