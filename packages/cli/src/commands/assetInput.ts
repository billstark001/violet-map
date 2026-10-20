import { defaultDataUrl } from '@violet-map/core/defaults';
import type { Rgb } from '@violet-map/render';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCapability } from '../capabilities.js';

import { type AssetBundle, type BlockInfo, type BlockInfoMap } from '@violet-map/core/assets';
import { forEachConcurrent } from '@violet-map/core/async';
import { PNG } from 'pngjs';
import { isMissingPath, resolvePath } from './paths.js';

export const MAX_PARALLEL_ASSET_READS = 16;

export function textureIdForPath(namespace: string, rel: string): string {
  return `${namespace}:${rel.slice(0, -4)}`;
}

export function averagePngColor(bytes: Uint8Array): Rgb | null {
  try {
    const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      const alpha = png.data[i + 3];
      if (alpha < 32) continue;
      r += png.data[i];
      g += png.data[i + 1];
      b += png.data[i + 2];
      n++;
    }
    return n ? [r / n / 255, g / n / 255, b / n / 255] : null;
  } catch (error) {
    throw new Error('invalid texture PNG', { cause: error });
  }
}

export async function readTextureAverageColors(assetDirs: string[]): Promise<Map<string, Rgb>> {
  const { createAssetPack } = await loadCapability('@violet-map/resources/asset-pack');
  const assets = createAssetPack({
    assets: { dirs: assetDirs },
    cache: { textureBytes: 0 },
  });
  const colors = new Map<string, Rgb>();
  for (const id of await assets.textureIds()) {
    const texture = await assets.readTextureFile(id);
    if (!texture) continue;
    const color = averagePngColor(texture.bytes);
    if (color) colors.set(id, color);
  }
  return colors;
}

export interface AssetFile {
  rel: string;
  file: string;
}

export async function collectMatchingFiles(dir: string, suffix: string, out: AssetFile[], rel = ''): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectMatchingFiles(file, suffix, out, childRel);
    else if (entry.isFile() && entry.name.endsWith(suffix)) out.push({ rel: childRel, file });
  }
}

export async function visitMatchingFiles(
  dir: string,
  suffix: string,
  onFile: (rel: string, file: string) => Promise<void>,
): Promise<void> {
  const files: AssetFile[] = [];
  await collectMatchingFiles(dir, suffix, files);
  await forEachConcurrent(files, MAX_PARALLEL_ASSET_READS, (item) => onFile(item.rel, item.file));
}

export async function readPngTree(dir: string, onFile: (rel: string, file: string) => Promise<void>): Promise<void> {
  await visitMatchingFiles(dir, '.png', onFile);
}

export function dataFileCandidates(name: string, explicit?: string): string[] {
  if (explicit) return [resolvePath(explicit)];
  const out: string[] = [];
  const dataDir = process.env.DATA_DIR ? resolvePath(process.env.DATA_DIR) : null;
  const version = process.env.MC_VERSION;
  if (dataDir && version) out.push(path.join(dataDir, 'versions', version, name));
  if (dataDir) out.push(path.join(dataDir, name));
  out.push(fileURLToPath(defaultDataUrl(name as 'biomes.json' | 'dimensions.json' | 'block-overrides.json')));
  return out;
}

export async function readJsonFirst<T>(candidates: string[]): Promise<T | null> {
  for (const file of candidates) {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (isMissingPath(error)) continue;
      throw error;
    }
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new Error(`invalid JSON in ${file}`, { cause: error });
    }
  }
  return null;
}

export async function readColormapFromAssets(assetDirs: string[], name: string): Promise<Uint8Array | null> {
  const { createAssetPack } = await loadCapability('@violet-map/resources/asset-pack');
  const assets = createAssetPack({
    assets: { dirs: assetDirs },
    cache: { textureBytes: 0 },
  });
  const texture = await assets.readTextureFile(`minecraft:colormap/${name}`);
  if (!texture) return null;
  const png = PNG.sync.read(Buffer.from(texture.bytes));
  if (png.width !== 256 || png.height !== 256) throw new Error('colormap must be 256 by 256');
  return Uint8Array.from(png.data);
}

export async function loadBlockInfo(file?: string): Promise<BlockInfoMap | undefined> {
  if (file) return JSON.parse(await fs.readFile(resolvePath(file), 'utf8')) as BlockInfoMap;
  const { createGameDataSource } = await loadCapability('@violet-map/resources/game-data');
  return createGameDataSource({
    dataVersion: process.env.MC_DATA_VERSION ?? process.env.MC_VERSION ?? '1.21.4',
    readOverrides: async () =>
      (await readJsonFirst<Record<string, Partial<BlockInfo>>>(dataFileCandidates('block-overrides.json'))) ?? {},
  }).buildBlockInfo();
}

export async function loadAssetBundleFromDirs(dirs: string[]): Promise<AssetBundle> {
  const { createAssetPack } = await loadCapability('@violet-map/resources/asset-pack');
  return createAssetPack({
    assets: { dirs },
    cache: { textureBytes: 0 },
  }).buildAssetBundle();
}
