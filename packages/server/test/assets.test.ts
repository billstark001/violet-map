import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';

test('atlas keeps animation frames when interpolation would exceed the pixel budget', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'violet-atlas-'));
  const previousAssetsDirs = process.env.ASSETS_DIRS;
  process.env.ASSETS_DIRS = root;
  try {
    const textureDir = path.join(root, 'test', 'textures', 'block');
    await mkdir(textureDir, { recursive: true });
    const png = new PNG({ width: 256, height: 1024 });
    png.data.fill(255);
    await writeFile(path.join(textureDir, 'sheet.png'), PNG.sync.write(png));
    await writeFile(
      path.join(textureDir, 'sheet.png.mcmeta'),
      JSON.stringify({ animation: { frametime: 255, interpolate: true } }),
    );
    const { buildTextureAtlas } = await import('../src/assets.js');
    const { manifest } = await buildTextureAtlas(['test:block/sheet']);
    assert.equal(manifest.index['test:block/sheet'].animation?.frames.length, 4);
    assert.deepEqual(manifest.index['test:block/sheet'].animation?.times, [255, 255, 255, 255]);
  } finally {
    if (previousAssetsDirs === undefined) delete process.env.ASSETS_DIRS;
    else process.env.ASSETS_DIRS = previousAssetsDirs;
    await rm(root, { recursive: true, force: true });
  }
});
