import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import fs from 'node:fs/promises';
import { decode, encode } from '@msgpack/msgpack';
import { config } from './config.js';
import { buildAssetBundle, buildTextureAtlas, clearTextureAtlasCache, getTextureAtlasPng, textureFilePath } from './assets.js';
import { buildBlockInfo, readBiomes, readDimensions, writeDataFile } from './gameData.js';
import { getChunkNbt, listRegions, listWorlds, saveChunkNbt, saveRegionFile } from './worldStore.js';

const app = new Hono();
app.use('*', cors());

function msgpackBody(value: unknown): ArrayBuffer {
  const bytes = encode(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

app.get('/api/worlds', async (c) => c.json(await listWorlds()));
app.get('/api/worlds/:world/:dim/regions', async (c) =>
  c.json(await listRegions(c.req.param('world'), c.req.param('dim'))));

app.get('/api/worlds/:world/:dim/chunk/:cx/:cz', async (c) => {
  const cx = Number(c.req.param('cx')), cz = Number(c.req.param('cz'));
  if (!Number.isInteger(cx) || !Number.isInteger(cz)) return c.text('bad coords', 400);
  const data = await getChunkNbt(c.req.param('world'), c.req.param('dim'), cx, cz);
  if (!data) return c.body(null, 204, { 'cache-control': 'private, max-age=15' });
  return c.body(msgpackBody({ cx, cz, data }), 200, {
    'cache-control': 'private, max-age=15',
    'content-type': 'application/msgpack',
  });
});

app.post('/api/worlds/:world/:dim/chunks', async (c) => {
  const body = decode(new Uint8Array(await c.req.arrayBuffer())) as { chunks?: { cx: number; cz: number }[] };
  const requested = Array.isArray(body?.chunks) ? body.chunks.slice(0, 128) : [];
  const chunks = await Promise.all(requested.map(async ({ cx, cz }) => {
    if (!Number.isInteger(cx) || !Number.isInteger(cz)) return null;
    const data = await getChunkNbt(c.req.param('world'), c.req.param('dim'), cx, cz);
    return data ? { cx, cz, data } : { cx, cz, missing: true };
  }));
  return c.body(msgpackBody({ chunks: chunks.filter(Boolean) }), 200, {
    'cache-control': 'private, max-age=15',
    'content-type': 'application/msgpack',
  });
});

app.get('/api/assets/bundle', async (c) => c.json(await buildAssetBundle()));
app.post('/api/assets/reload', async (c) => { await buildAssetBundle(true); clearTextureAtlasCache(); return c.json({ ok: true }); });

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
app.put('/api/data/biomes', async (c) => { await writeDataFile('biomes.json', await c.req.json()); return c.json({ ok: true }); });
app.get('/api/data/dimensions', async (c) => c.json(await readDimensions()));

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
