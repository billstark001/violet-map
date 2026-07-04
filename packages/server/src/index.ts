import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import fs from 'node:fs/promises';
import { config } from './config.js';
import { buildAssetBundle, textureFilePath } from './assets.js';
import { buildBlockInfo, readBiomes, readDimensions, writeDataFile } from './gameData.js';
import { getChunkNbt, listRegions, listWorlds, saveChunkNbt, saveRegionFile } from './worldStore.js';

const app = new Hono();
app.use('*', cors());

app.get('/api/worlds', async (c) => c.json(await listWorlds()));
app.get('/api/worlds/:world/:dim/regions', async (c) =>
  c.json(await listRegions(c.req.param('world'), c.req.param('dim'))));

app.get('/api/worlds/:world/:dim/chunk/:cx/:cz', async (c) => {
  const cx = Number(c.req.param('cx')), cz = Number(c.req.param('cz'));
  if (!Number.isInteger(cx) || !Number.isInteger(cz)) return c.text('bad coords', 400);
  const data = await getChunkNbt(c.req.param('world'), c.req.param('dim'), cx, cz);
  if (!data) return c.text('chunk not found', 404);
  return c.body(data.slice().buffer as ArrayBuffer, 200, {
    'content-type': 'application/octet-stream',
    'cache-control': 'no-cache',
  });
});

app.get('/api/assets/bundle', async (c) => c.json(await buildAssetBundle()));
app.post('/api/assets/reload', async (c) => { await buildAssetBundle(true); return c.json({ ok: true }); });

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

console.log(`[mcr] server on :${config.port}\n  worlds: ${config.worldsDir}\n  assets: ${config.assetsDirs.join(', ')}`);
void buildAssetBundle();
serve({ fetch: app.fetch, port: config.port });