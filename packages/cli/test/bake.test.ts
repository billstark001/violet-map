import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runBakeTopMap } from '../src/commands/bake.js';
import { loadAssetBundleFromDirs, loadBiomeColors } from '../src/commands/common.js';

test('top-map bake validates strides before scanning regions', async () => {
  await assert.rejects(runBakeTopMap(['/missing/world', '--sample-stride', '3']), /sample stride must evenly divide/);
  await assert.rejects(runBakeTopMap(['/missing/world', '--dim', 'mod:foo/../private']), /invalid dimension id/);
});

test('an explicit malformed biome file reports its path', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-biomes-'));
  const file = path.join(root, 'biomes.json');
  await fs.writeFile(file, '{broken');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(loadBiomeColors([], file), /invalid JSON in .*biomes\.json/);
});

test('asset scanning finds nested JSON and skips malformed optional models', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-assets-'));
  const models = path.join(root, 'mod', 'models', 'block');
  await fs.mkdir(models, { recursive: true });
  await fs.writeFile(path.join(models, 'valid.json'), '{}');
  await fs.writeFile(path.join(models, 'broken.json'), '{broken');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const bundle = await loadAssetBundleFromDirs([root]);
  assert.deepEqual(bundle.models['mod:block/valid'], {});
  assert.equal(bundle.models['mod:block/broken'], undefined);
});

test('top-map bake keeps a malformed existing manifest for repair', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-bake-'));
  const world = path.join(root, 'world');
  const out = path.join(root, 'out');
  const assets = path.join(root, 'assets');
  await Promise.all([fs.mkdir(world), fs.mkdir(out), fs.mkdir(assets)]);
  const manifestPath = path.join(out, 'manifest.json');
  await fs.writeFile(manifestPath, '{broken');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await assert.rejects(
    runBakeTopMap([world, '--out', out, '--assets-dir', assets]),
    /invalid top-map manifest: .*manifest\.json/,
  );
  assert.equal(await fs.readFile(manifestPath, 'utf8'), '{broken');
});
