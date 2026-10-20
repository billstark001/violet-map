import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PNG } from 'pngjs';
import { createAssetPack } from '../src/assetPack.js';

test('asset JSON size is checked before allocation and a failed build does not retain a rejected result', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'violet-asset-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'test/models');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'large.json');
  await writeFile(file, '{}');
  await truncate(file, 8 * 1024 ** 2 + 1);
  const pack = createAssetPack({ assets: { dirs: [root] }, cache: { textureBytes: 0 } });
  await assert.rejects(pack.buildAssetBundle(), { code: 'RESOURCE_BUSY' });
  await writeFile(file, '{}');
  assert.deepEqual((await pack.buildAssetBundle()).models['test:large'], {});
});

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
    const { createAssetPack } = await import('../src/assetPack.js');
    const { prepareTextureAtlas } = createAssetPack({
      assets: { dirs: [root] },
      cache: { textureBytes: 0 },
    });
    const { manifest } = await (await prepareTextureAtlas(['test:block/sheet'])).generate();
    assert.equal(manifest.index['test:block/sheet'].animation?.frames.length, 4);
    assert.deepEqual(manifest.index['test:block/sheet'].animation?.times, [255, 255, 255, 255]);
  } finally {
    if (previousAssetsDirs === undefined) delete process.env.ASSETS_DIRS;
    else process.env.ASSETS_DIRS = previousAssetsDirs;
    await rm(root, { recursive: true, force: true });
  }
});
