import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { decode, encode } from '@msgpack/msgpack';
import { config } from './config.js';
import { parseByteRange } from './httpRange.js';
import { ChunkReadLimiter, ChunkServiceBusyError } from './chunkReadLimiter.js';
import { isChunkCoordinate, parseChunkCoordinates } from './chunkCoordinates.js';
import { readLimitedBody } from './limitedBody.js';
import { isDimensionId } from '@violet-map/core';
import { principalFor, requireRole } from './auth.js';
import { cleanStoragePath, worldStorage } from './storage.js';
import { createUser, deleteUser, issueCredential, listUsers, login, updateUser, asCreatableRole } from './users.js';
import {
  buildAssetBundle,
  buildTextureAtlas,
  clearTextureAtlasCache,
  getAssetBundlePayload,
  getTextureAtlasPng,
  readTextureFile,
  MAX_ATLAS_TEXTURES,
} from './assets.js';
import { buildBlockInfo, clearGameDataCaches, readBiomes, readDimensions, writeDataFile } from './gameData.js';
import { getTopMapManifest, getWorldCapabilities, readTopMapTile, warmTopMapManifests } from './topMap.js';
import {
  createWorld,
  deleteChunks,
  deleteRegion,
  deleteWorld,
  diffWorldManifest,
  getChunkMetadataBatch,
  getChunksNbtWithMetaBatch,
  getChunkNbtWithMeta,
  invalidateStoredFile,
  listChunkSourceCoverage,
  listRegions,
  listWorlds,
  saveChunkNbt,
  saveRegionFile,
  saveWorldFile,
  worldManifest,
} from './worldStore.js';

const app = new Hono();
app.use('*', cors());
app.use('/api/admin/*', requireRole('ci'));
app.use('/api/worlds/:world/:dim/*', async (c, next) => {
  if (!isDimensionId(c.req.param('dim'))) return c.json({ error: 'invalid dimension id' }, 400);
  await next();
});
app.use('/api/admin/worlds/:world/:dim/*', async (c, next) => {
  if (!isDimensionId(c.req.param('dim'))) return c.json({ error: 'invalid dimension id' }, 400);
  await next();
});

const MAX_DIAGNOSTIC_BYTES = 2 * 1024 * 1024;
const MAX_LOGIN_REQUEST_BYTES = 16 * 1024;
const MAX_CHUNK_REQUEST_BYTES = 64 * 1024;
const MAX_ATLAS_REQUEST_BYTES = 128 * 1024;
const MAX_CONCURRENT_CHUNK_READS = 8;
const MAX_QUEUED_CHUNK_READS = 64;
const objectPayloadCache = new WeakMap<object, { body: string; etag: string }>();
const chunkReadLimiter = new ChunkReadLimiter(MAX_CONCURRENT_CHUNK_READS, MAX_QUEUED_CHUNK_READS);

function msgpackBody(value: unknown): ArrayBuffer {
  const bytes = encode(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function publicChunkMeta<T extends { sourcePath?: string; entitySourcePath?: string }>(
  value: T,
): Omit<T, 'sourcePath' | 'entitySourcePath'> {
  const { sourcePath: _sourcePath, entitySourcePath: _entitySourcePath, ...rest } = value;
  return rest;
}

function jsonPayload(c: Context, payload: { body: string; etag: string }, cacheControl: string) {
  const headers = {
    etag: payload.etag,
    'cache-control': cacheControl,
    'content-type': 'application/json; charset=utf-8',
  };
  if (c.req.header('if-none-match') === payload.etag) return c.body(null, 304, headers);
  return c.body(payload.body, 200, headers);
}

function cachedObjectPayload(value: object): { body: string; etag: string } {
  const cached = objectPayloadCache.get(value);
  if (cached) return cached;
  const body = JSON.stringify(value);
  const payload = { body, etag: `"${createHash('sha1').update(body).digest('hex')}"` };
  objectPayloadCache.set(value, payload);
  return payload;
}

function adminStoragePath(c: { req: { path: string } }, segment: 'files' | 'stat'): string {
  const prefix = `/api/admin/storage/${segment}/`;
  return cleanStoragePath(decodeURIComponent(c.req.path.slice(prefix.length)));
}

app.post('/api/auth/login', async (c) => {
  const bytes = await readLimitedBody(c.req.raw, MAX_LOGIN_REQUEST_BYTES);
  if (!bytes) return c.json({ error: 'request body too large' }, 413);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  if (
    !body ||
    typeof body !== 'object' ||
    typeof (body as { username?: unknown }).username !== 'string' ||
    typeof (body as { password?: unknown }).password !== 'string'
  )
    return c.json({ error: 'username and password are required' }, 400);
  const credential = await login((body as { username: string }).username, (body as { password: string }).password);
  return credential ? c.json(credential) : c.json({ error: 'invalid credentials' }, 401);
});

app.get('/api/auth/me', requireRole('viewer'), async (c) => {
  const principal = await principalFor(c);
  return c.json(
    principal ? { id: principal.id, username: principal.username, role: principal.role } : { error: 'unauthorized' },
    principal ? 200 : 401,
  );
});

app.post('/api/diagnostics', requireRole('viewer'), async (c) => {
  const bytes = await readLimitedBody(c.req.raw, MAX_DIAGNOSTIC_BYTES);
  if (!bytes) {
    return c.json({ error: 'diagnostic payload too large' }, 413);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return c.json({ error: 'invalid diagnostic JSON' }, 400);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return c.json({ error: 'diagnostic payload must be an object' }, 400);
  }

  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const dir = path.join(config.dataDir, 'diagnostics');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${id}.json`),
    JSON.stringify(
      {
        receivedAt: new Date().toISOString(),
        payload,
      },
      null,
      2,
    ),
    { encoding: 'utf8', flag: 'wx' },
  );
  return c.json({ ok: true, id });
});

app.get('/api/worlds', async (c) => c.json(await listWorlds()));
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

app.get('/api/assets/bundle', async (c) =>
  jsonPayload(c, await getAssetBundlePayload(), 'public, max-age=300, must-revalidate'),
);
app.post('/api/assets/reload', requireRole('admin'), async (c) => {
  await buildAssetBundle(true);
  clearTextureAtlasCache();
  clearGameDataCaches();
  return c.json({ ok: true });
});

app.post('/api/assets/atlas', async (c) => {
  const bytes = await readLimitedBody(c.req.raw, MAX_ATLAS_REQUEST_BYTES);
  if (!bytes) return c.json({ error: 'request body too large' }, 413);
  let body: { ids?: unknown };
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as { ids?: unknown };
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  if (!Array.isArray(body.ids)) return c.json({ error: 'ids must be an array' }, 400);
  if (body.ids.length > MAX_ATLAS_TEXTURES)
    return c.json({ error: `at most ${MAX_ATLAS_TEXTURES} texture ids are allowed` }, 413);
  const ids: string[] = [];
  for (const id of body.ids) {
    if (typeof id !== 'string' || id.length > 200 || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id) || id.includes('..')) {
      return c.json({ error: 'invalid texture id' }, 400);
    }
    ids.push(id);
  }
  try {
    const { manifest } = await buildTextureAtlas(ids);
    return c.json(manifest, 200, { 'cache-control': 'public, max-age=300, must-revalidate' });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

app.get('/api/assets/atlas/:key', async (c) => {
  const key = c.req.param('key');
  if (!key) return c.text('atlas not found', 404);
  const png = getTextureAtlasPng(key);
  if (!png) return c.text('atlas not found', 404);
  return c.body(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer, 200, {
    'content-type': 'image/png',
    'cache-control': 'public, max-age=300, must-revalidate',
  });
});

app.get('/api/assets/texture/*', async (c) => {
  let id: string;
  try {
    id = decodeURIComponent(c.req.path.replace('/api/assets/texture/', ''));
  } catch {
    return c.text('invalid texture id', 400);
  }
  const texture = await readTextureFile(id);
  if (!texture) return c.text('texture not found', 404);
  const headers = {
    etag: texture.etag,
    'content-type': 'image/png',
    'cache-control': 'public, max-age=3600, must-revalidate',
  };
  if (c.req.header('if-none-match') === texture.etag) return c.body(null, 304, headers);
  return c.body(
    texture.bytes.buffer.slice(
      texture.bytes.byteOffset,
      texture.bytes.byteOffset + texture.bytes.byteLength,
    ) as ArrayBuffer,
    200,
    {
      ...headers,
    },
  );
});

app.get('/api/data/blocks', async (c) =>
  jsonPayload(c, cachedObjectPayload(await buildBlockInfo()), 'public, max-age=60, must-revalidate'),
);
app.get('/api/data/biomes', async (c) =>
  jsonPayload(c, cachedObjectPayload(await readBiomes()), 'public, max-age=60, must-revalidate'),
);
app.put('/api/data/biomes', requireRole('admin'), async (c) => {
  await writeDataFile('biomes.json', await c.req.json());
  return c.json({ ok: true });
});
app.get('/api/data/dimensions', async (c) =>
  jsonPayload(c, cachedObjectPayload(await readDimensions()), 'public, max-age=60, must-revalidate'),
);

app.get('/api/admin/users', requireRole('admin'), async (c) => c.json(await listUsers()));

app.post('/api/admin/users', requireRole('admin'), async (c) => {
  const body = await c.req
    .json<{ username?: string; password?: string; role?: string }>()
    .catch(() => ({}) as { username?: string; password?: string; role?: string });
  const role = asCreatableRole(body.role);
  if (!role || typeof body.username !== 'string' || typeof body.password !== 'string') {
    return c.json({ error: 'username, password, and a non-special role are required' }, 400);
  }
  try {
    return c.json(await createUser({ username: body.username, password: body.password, role }), 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

app.patch('/api/admin/users/:username', requireRole('admin'), async (c) => {
  const body = await c.req
    .json<{ password?: string; role?: string; enabled?: boolean }>()
    .catch(() => ({}) as { password?: string; role?: string; enabled?: boolean });
  const role = body.role === undefined ? undefined : asCreatableRole(body.role);
  if (body.role !== undefined && !role)
    return c.json({ error: 'root and guest are reserved roles and cannot be assigned' }, 400);
  if (body.password !== undefined && typeof body.password !== 'string')
    return c.json({ error: 'password must be a string' }, 400);
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean')
    return c.json({ error: 'enabled must be a boolean' }, 400);
  try {
    return c.json(await updateUser(c.req.param('username'), { password: body.password, role, enabled: body.enabled }));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

app.delete('/api/admin/users/:username', requireRole('admin'), async (c) => {
  try {
    await deleteUser(c.req.param('username'));
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

app.post('/api/admin/users/:username/credentials', requireRole('admin'), async (c) => {
  const body = await c.req.json<{ expiresInSeconds?: number }>().catch(() => ({}) as { expiresInSeconds?: number });
  const principal = await principalFor(c);
  if (!principal) return c.json({ error: 'unauthorized' }, 401);
  try {
    return c.json(await issueCredential(c.req.param('username'), Number(body.expiresInSeconds), principal), 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

// These protected primitive endpoints are the server side of ServerWorldStorage.
app.get('/api/admin/storage/list', async (c) => c.json(await worldStorage.list(c.req.query('prefix') ?? '')));
app.get('/api/admin/storage/directories', async (c) =>
  c.json(await worldStorage.listDirectories(c.req.query('prefix') ?? '')),
);
app.get('/api/admin/storage/stat/*', async (c) => {
  const info = await worldStorage.stat(adminStoragePath(c, 'stat'));
  return info ? c.json(info) : c.json({ error: 'not found' }, 404);
});
app.get('/api/admin/storage/files/*', async (c) => {
  const filePath = adminStoragePath(c, 'files');
  const info = await worldStorage.stat(filePath);
  if (!info) return c.json({ error: 'not found' }, 404);
  const rangeHeader = c.req.header('range');
  const range = rangeHeader === undefined ? null : parseByteRange(rangeHeader, info.size);
  if (rangeHeader !== undefined && !range)
    return c.body(null, 416, { 'content-range': `bytes */${info.size}`, 'accept-ranges': 'bytes' });
  const bytes = range
    ? await worldStorage.readRange(filePath, range.start, range.end - range.start + 1)
    : await worldStorage.read(filePath);
  if (!bytes) return c.json({ error: 'not found' }, 404);
  if (range && bytes.byteLength === 0) {
    const latest = await worldStorage.stat(filePath);
    return c.body(null, 416, {
      'content-range': `bytes */${latest?.size ?? info.size}`,
      'accept-ranges': 'bytes',
    });
  }
  const responseBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return c.body(
    responseBytes,
    range ? 206 : 200,
    range
      ? {
          'content-range': `bytes ${range.start}-${range.start + bytes.byteLength - 1}/${info.size}`,
          'accept-ranges': 'bytes',
        }
      : undefined,
  );
});
app.put('/api/admin/storage/files/*', async (c) => {
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const filePath = adminStoragePath(c, 'files');
  await worldStorage.write(filePath, bytes, c.req.header('content-type') ?? undefined);
  invalidateStoredFile(filePath);
  return c.json({ ok: true });
});
app.delete('/api/admin/storage/files/*', async (c) => {
  const filePath = adminStoragePath(c, 'files');
  await worldStorage.delete(filePath);
  invalidateStoredFile(filePath);
  return c.json({ ok: true });
});

app.get('/api/admin/worlds/:world/manifest', async (c) =>
  c.json({
    world: c.req.param('world'),
    files: await worldManifest(c.req.param('world')),
  }),
);

app.post('/api/admin/worlds/:world/diff', async (c) => {
  const body = await c.req.json<{ files?: { path: string; hash?: string; size?: number }[] }>();
  return c.json(await diffWorldManifest(c.req.param('world'), Array.isArray(body.files) ? body.files : []));
});

app.post('/api/admin/worlds', async (c) => {
  const body = await c.req.json<{ world?: string; levelName?: string; dimensions?: string[] }>();
  if (!body.world) return c.json({ error: 'missing world' }, 400);
  return c.json(await createWorld(body.world, body.dimensions, body.levelName));
});

app.post('/api/admin/worlds/:world/create', async (c) => {
  const body: { levelName?: string; dimensions?: string[] } = await c.req
    .json<{ levelName?: string; dimensions?: string[] }>()
    .catch(() => ({}));
  return c.json(await createWorld(c.req.param('world'), body.dimensions, body.levelName));
});

app.put('/api/admin/worlds/:world/files/*', async (c) => {
  const world = c.req.param('world');
  const prefix = `/api/admin/worlds/${world}/files/`;
  const relativePath = decodeURIComponent(c.req.path.slice(prefix.length));
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  return c.json(await saveWorldFile(world, relativePath, bytes));
});

app.post('/api/admin/worlds/:world/files', async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  const relativePath = String(body.path || (file instanceof File ? file.name : ''));
  if (!(file instanceof File)) return c.json({ error: 'missing file' }, 400);
  return c.json(await saveWorldFile(c.req.param('world'), relativePath, new Uint8Array(await file.arrayBuffer())));
});

app.delete('/api/admin/worlds/:world', async (c) => c.json(await deleteWorld(c.req.param('world'))));

app.delete('/api/admin/worlds/:world/:dim/regions/:rx/:rz', async (c) => {
  const rx = Number(c.req.param('rx')),
    rz = Number(c.req.param('rz'));
  if (!Number.isInteger(rx) || !Number.isInteger(rz)) return c.json({ error: 'bad region coords' }, 400);
  return c.json(await deleteRegion(c.req.param('world'), c.req.param('dim'), rx, rz));
});

app.delete('/api/admin/worlds/:world/:dim/chunks', async (c) => {
  const body = await c.req.json<{ chunks?: { cx: number; cz: number }[] }>();
  return c.json(
    await deleteChunks(c.req.param('world'), c.req.param('dim'), Array.isArray(body.chunks) ? body.chunks : []),
  );
});

app.post('/api/admin/worlds/:world/upload', async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.json({ error: 'missing file' }, 400);
  const world = c.req.param('world');
  const dim = String(body.dim || 'minecraft:overworld');
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    if (file.name.endsWith('.mca')) {
      await saveRegionFile(world, dim, file.name, bytes);
      return c.json({ ok: true, type: 'region', name: file.name });
    }
    const pos = await saveChunkNbt(world, dim, bytes);
    return c.json({ ok: true, type: 'chunk', ...pos });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

console.log(
  `[violet-map] server on :${config.port}\n  worlds: ${config.worldsDir}\n  assets: ${config.assetsDirs.join(', ')}`,
);
void buildAssetBundle().catch((error) => console.error('[violet-map] failed to warm asset bundle', error));
void warmTopMapManifests().catch((error) => console.error('[violet-map] failed to warm top-map manifests', error));
serve({ fetch: app.fetch, port: config.port });
