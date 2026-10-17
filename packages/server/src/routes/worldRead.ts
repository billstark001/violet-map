import type { RouteContext } from './context.js';

export function mountWorldRead(context: RouteContext) {
  const {
    app,
    getTopMapManifest,
    getWorldCapabilities,
    readTopMapTile,
    getChunkMetadataBatch,
    getChunksNbtWithMetaBatch,
    getChunkNbtWithMeta,
    listChunkSourceCoverage,
    listRegions,
    listWorlds,
    MAX_CHUNK_REQUEST_BYTES,
    chunkReadLimiter,
    msgpackBody,
    publicChunkMeta,
    decode,
    ChunkServiceBusyError,
    isChunkCoordinate,
    parseChunkCoordinates,
    readLimitedBody,
    isDimensionId,
  } = context;
  app.use('/api/worlds/:world/:dim/*', async (c, next) => {
    if (!isDimensionId(c.req.param('dim'))) return c.json({ error: 'invalid dimension id' }, 400);
    await next();
  });
  app.get('/api/worlds', async (c) => {
    const worlds = await listWorlds();
    if (!context.content) return c.json(worlds);
    try {
      const maps = await context.content.listMaps();
      return c.json(
        worlds.map((world) => ({
          ...world,
          mapIds: maps.filter((map) => map.worldKey === world.id).map((map) => map.mapId),
        })),
      );
    } catch {
      return c.json(worlds);
    }
  });
  app.get('/api/worlds/:world/capabilities', async (c) => c.json(await getWorldCapabilities(c.req.param('world'))));
  app.get('/api/worlds/:world/:dim/regions', async (c) =>
    c.json(await listRegions(c.req.param('world'), decodeURIComponent(c.req.param('dim')))),
  );
  app.get('/api/worlds/:world/:dim/chunk-coverage', async (c) =>
    c.json(await listChunkSourceCoverage(c.req.param('world'), decodeURIComponent(c.req.param('dim')))),
  );
  app.get('/api/worlds/:world/:dim/top-map/manifest', async (c) => {
    const manifest = await getTopMapManifest(c.req.param('world'));
    const dim = decodeURIComponent(c.req.param('dim'));
    const dimension = manifest?.dimensions[dim];
    if (!manifest || !dimension) return c.json({ error: 'top map not found' }, 404);
    return c.json({ ...dimension, world: c.req.param('world'), dimension: dim }, 200, {
      'cache-control': 'public, max-age=60, must-revalidate',
    });
  });
  app.get('/api/worlds/:world/:dim/top-map/tile/:rx/:rz', async (c) => {
    const rx = Number(c.req.param('rx')),
      rz = Number(c.req.param('rz'));
    if (!Number.isInteger(rx) || !Number.isInteger(rz)) return c.text('bad region coords', 400);
    const bytes = await readTopMapTile(c.req.param('world'), decodeURIComponent(c.req.param('dim')), rx, rz);
    if (!bytes) return c.text('top-map tile not found', 404);
    return c.body(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 200, {
      'cache-control': 'public, max-age=60, must-revalidate',
      'content-type': 'application/msgpack',
    });
  });
  app.get('/api/worlds/:world/:dim/chunk/:cx/:cz', async (c) => {
    const cx = Number(c.req.param('cx')),
      cz = Number(c.req.param('cz'));
    if (!isChunkCoordinate(cx) || !isChunkCoordinate(cz)) return c.text('bad coords', 400);
    let chunk;
    try {
      chunk = await chunkReadLimiter.run(() => getChunkNbtWithMeta(c.req.param('world'), c.req.param('dim'), cx, cz));
    } catch (error) {
      if (error instanceof ChunkServiceBusyError) return c.json({ error: error.message }, 503, { 'retry-after': '1' });
      throw error;
    }
    if (!chunk) return c.body(null, 204, { 'cache-control': 'private, max-age=15' });
    return c.body(msgpackBody(publicChunkMeta(chunk)), 200, {
      'cache-control': 'private, max-age=15',
      'content-type': 'application/msgpack',
    });
  });
  app.post('/api/worlds/:world/:dim/chunk-hashes', async (c) => {
    const bytes = await readLimitedBody(c.req.raw, MAX_CHUNK_REQUEST_BYTES);
    if (!bytes) return c.json({ error: 'request body too large' }, 413);
    let body: unknown;
    try {
      body = decode(bytes);
    } catch {
      return c.json({ error: 'invalid msgpack' }, 400);
    }
    const requested = parseChunkCoordinates(body, 256);
    if (!requested) return c.json({ error: 'invalid chunk coordinates' }, 400);
    let metas;
    try {
      metas = await chunkReadLimiter.run(() =>
        getChunkMetadataBatch(c.req.param('world'), c.req.param('dim'), requested),
      );
    } catch (error) {
      if (error instanceof ChunkServiceBusyError) return c.json({ error: error.message }, 503, { 'retry-after': '1' });
      throw error;
    }
    return c.body(msgpackBody({ chunks: metas.map(publicChunkMeta) }), 200, {
      'cache-control': 'private, max-age=15',
      'content-type': 'application/msgpack',
    });
  });
  app.post('/api/worlds/:world/:dim/chunks', async (c) => {
    const bytes = await readLimitedBody(c.req.raw, MAX_CHUNK_REQUEST_BYTES);
    if (!bytes) return c.json({ error: 'request body too large' }, 413);
    let body: unknown;
    try {
      body = decode(bytes);
    } catch {
      return c.json({ error: 'invalid msgpack' }, 400);
    }
    const requested = parseChunkCoordinates(body, 128);
    if (!requested) return c.json({ error: 'invalid chunk coordinates' }, 400);
    let chunks;
    try {
      chunks = await chunkReadLimiter.run(() =>
        getChunksNbtWithMetaBatch(c.req.param('world'), c.req.param('dim'), requested),
      );
    } catch (error) {
      if (error instanceof ChunkServiceBusyError) return c.json({ error: error.message }, 503, { 'retry-after': '1' });
      throw error;
    }
    return c.body(
      msgpackBody({
        chunks: chunks.map((chunk, index) => (chunk ? publicChunkMeta(chunk) : { ...requested[index], missing: true })),
      }),
      200,
      {
        'cache-control': 'private, max-age=15',
        'content-type': 'application/msgpack',
      },
    );
  });
}
