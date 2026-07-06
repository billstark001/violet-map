import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import fs from 'node:fs/promises';
import { decode, encode } from '@msgpack/msgpack';
import { config } from './config.js';
import { requireRole } from './auth.js';
import { buildAssetBundle, buildTextureAtlas, clearTextureAtlasCache, getTextureAtlasPng, textureFilePath } from './assets.js';
import { buildBlockInfo, readBiomes, readDimensions, writeDataFile } from './gameData.js';
import {
  createWorld,
  deleteChunks,
  deleteRegion,
  deleteWorld,
  diffWorldManifest,
  getChunkMetadataBatch,
  getChunksNbtWithMetaBatch,
  getChunkNbtWithMeta,
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

function msgpackBody(value: unknown): ArrayBuffer {
  const bytes = encode(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function publicChunkMeta<T extends { sourcePath?: string }>(value: T): Omit<T, 'sourcePath'> {
  const { sourcePath: _sourcePath, ...rest } = value;
  return rest;
}

function requestedChunks(raw: unknown): { cx: number; cz: number }[] {
  const body = raw as { chunks?: { cx: number; cz: number }[] };
  return Array.isArray(body?.chunks) ? body.chunks.slice(0, 256) : [];
}

app.get('/api/worlds', async (c) => c.json(await listWorlds()));
app.get('/api/worlds/:world/:dim/regions', async (c) =>
  c.json(await listRegions(c.req.param('world'), c.req.param('dim'))));

app.get('/api/worlds/:world/:dim/chunk/:cx/:cz', async (c) => {
  const cx = Number(c.req.param('cx')), cz = Number(c.req.param('cz'));
  if (!Number.isInteger(cx) || !Number.isInteger(cz)) return c.text('bad coords', 400);
  const chunk = await getChunkNbtWithMeta(c.req.param('world'), c.req.param('dim'), cx, cz);
  if (!chunk) return c.body(null, 204, { 'cache-control': 'private, max-age=15' });
  return c.body(msgpackBody(publicChunkMeta(chunk)), 200, {
    'cache-control': 'private, max-age=15',
    'content-type': 'application/msgpack',
  });
});

app.post('/api/worlds/:world/:dim/chunk-hashes', async (c) => {
  const body = decode(new Uint8Array(await c.req.arrayBuffer()));
  const metas = await getChunkMetadataBatch(c.req.param('world'), c.req.param('dim'), requestedChunks(body));
  return c.body(msgpackBody({ chunks: metas.map(publicChunkMeta) }), 200, {
    'cache-control': 'private, max-age=15',
    'content-type': 'application/msgpack',
  });
});

app.post('/api/worlds/:world/:dim/chunks', async (c) => {
  const body = decode(new Uint8Array(await c.req.arrayBuffer()));
  const requested = requestedChunks(body).slice(0, 128);
  const chunks = await getChunksNbtWithMetaBatch(c.req.param('world'), c.req.param('dim'), requested);
  return c.body(msgpackBody({
    chunks: chunks.map((chunk, index) => chunk ? publicChunkMeta(chunk) : { ...requested[index], missing: true }),
  }), 200, {
    'cache-control': 'private, max-age=15',
    'content-type': 'application/msgpack',
  });
});

app.get('/api/assets/bundle', async (c) => c.json(await buildAssetBundle()));
app.post('/api/assets/reload', requireRole('admin'), async (c) => { await buildAssetBundle(true); clearTextureAtlasCache(); return c.json({ ok: true }); });

app.post('/api/assets/atlas', async (c) => {
  const body = await c.req.json<{ ids?: string[] }>();
  const ids = Array.isArray(body?.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : [];
  const { manifest } = await buildTextureAtlas(ids);
  return c.json(manifest, 200, { 'cache-control': 'private, max-age=3600' });
});

app.get('/api/assets/atlas/:key', async (c) => {
  const key = c.req.param('key');
  if (!key) return c.text('atlas not found', 404);
  const png = getTextureAtlasPng(key);
  if (!png) return c.text('atlas not found', 404);
  return c.body(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer, 200, {
    'content-type': 'image/png',
    'cache-control': 'private, max-age=3600',
  });
});

app.get('/api/assets/texture/*', async (c) => {
  const id = decodeURIComponent(c.req.path.replace('/api/assets/texture/', ''));
  const file = await textureFilePath(id);
  if (!file) return c.text('texture not found', 404);
  const bytes = await fs.readFile(file);
  return c.body(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 200, {
    'content-type': 'image/png',
    'cache-control': 'public, max-age=3600',
  });
});

app.get('/api/data/blocks', async (c) => c.json(await buildBlockInfo()));
app.get('/api/data/biomes', async (c) => c.json(await readBiomes()));
app.put('/api/data/biomes', requireRole('admin'), async (c) => { await writeDataFile('biomes.json', await c.req.json()); return c.json({ ok: true }); });
app.get('/api/data/dimensions', async (c) => c.json(await readDimensions()));

app.get('/api/admin/worlds/:world/manifest', async (c) => c.json({
  world: c.req.param('world'),
  files: await worldManifest(c.req.param('world')),
}));

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
  const body: { levelName?: string; dimensions?: string[] } = await c.req.json<{ levelName?: string; dimensions?: string[] }>().catch(() => ({}));
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
  const rx = Number(c.req.param('rx')), rz = Number(c.req.param('rz'));
  if (!Number.isInteger(rx) || !Number.isInteger(rz)) return c.json({ error: 'bad region coords' }, 400);
  return c.json(await deleteRegion(c.req.param('world'), c.req.param('dim'), rx, rz));
});

app.delete('/api/admin/worlds/:world/:dim/chunks', async (c) => {
  const body = await c.req.json<{ chunks?: { cx: number; cz: number }[] }>();
  return c.json(await deleteChunks(c.req.param('world'), c.req.param('dim'), Array.isArray(body.chunks) ? body.chunks : []));
});

app.post('/api/admin/upload', async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return c.json({ error: 'missing file' }, 400);
  const world = String(body.world || 'uploads');
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

console.log(`[violet-map] server on :${config.port}\n  worlds: ${config.worldsDir}\n  assets: ${config.assetsDirs.join(', ')}`);
void buildAssetBundle();
serve({ fetch: app.fetch, port: config.port });
