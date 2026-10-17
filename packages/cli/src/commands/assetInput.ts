import { applyBlockInfoOverrides, createBlockInfoMap } from '@violet-map/core/assets';
import { defaultDataUrl } from '@violet-map/core/defaults';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Rgb } from '@violet-map/render';

import { forEachConcurrent } from '@violet-map/core/async';
import { type AssetBundle, type BlockModelJson, type BlockInfo, type BlockInfoMap } from '@violet-map/core/assets';
import minecraftData from 'minecraft-data';
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
  } catch {
    return null;
  }
}

export async function readTextureAverageColors(assetDirs: string[]): Promise<Map<string, Rgb>> {
  const colors = new Map<string, Rgb>();
  for (const dir of assetDirs.map((d) => resolvePath(d))) {
    let namespaces: string[] = [];
    try {
      namespaces = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (error) {
      if (isMissingPath(error)) continue;
      throw error;
    }
    for (const ns of namespaces) {
      await readPngTree(path.join(dir, ns, 'textures'), async (rel, file) => {
        const avg = averagePngColor(await fs.readFile(file));
        if (avg) colors.set(textureIdForPath(ns, rel), avg);
      });
    }
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
  for (const dir of assetDirs.map((d) => resolvePath(d))) {
    const file = path.join(dir, 'minecraft/textures/colormap', `${name}.png`);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(file);
    } catch (error) {
      if (isMissingPath(error)) continue;
      throw error;
    }
    try {
      const png = PNG.sync.read(bytes);
      if (png.width !== 256 || png.height !== 256) continue;
      return Uint8Array.from(png.data);
    } catch {
      // A malformed optional colormap does not block the next asset directory.
    }
  }
  return null;
}

export function latestSupportedMcDataVersion(): string {
  const versions = (minecraftData as any).supportedVersions?.pc as string[] | undefined;
  return versions?.[versions.length - 1] ?? '1.21.11';
}

export function loadMinecraftData(version = process.env.MC_DATA_VERSION ?? process.env.MC_VERSION ?? '1.21.4') {
  try {
    const data = minecraftData(version);
    if (!data) throw new Error(`minecraft-data returned no data for ${version}`);
    return data;
  } catch (error) {
    const fallback = latestSupportedMcDataVersion();
    if (version === fallback) throw error;
    const data = minecraftData(fallback);
    if (!data) throw error;
    return data;
  }
}

export async function loadBlockInfo(file?: string): Promise<BlockInfoMap | undefined> {
  if (file) return JSON.parse(await fs.readFile(resolvePath(file), 'utf8')) as BlockInfoMap;
  const data = loadMinecraftData();
  const map = createBlockInfoMap(data.blocksArray);
  const overrides = await readJsonFirst<Record<string, Partial<BlockInfo>>>(dataFileCandidates('block-overrides.json'));
  if (overrides) applyBlockInfoOverrides(map, overrides);
  return map;
}

export async function loadAssetBundleFromDirs(dirs: string[]): Promise<AssetBundle> {
  const bundle: AssetBundle = { blockstates: {}, models: {} };
  for (const dir of dirs.map((d) => resolvePath(d))) {
    let namespaces: string[] = [];
    try {
      namespaces = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (error) {
      if (isMissingPath(error)) continue;
      throw error;
    }
    for (const ns of namespaces) {
      await readJsonTree(path.join(dir, ns, 'blockstates'), (rel, value) => {
        bundle.blockstates[`${ns}:${rel.slice(0, -5)}`] = value;
      });
      await readJsonTree(path.join(dir, ns, 'models'), (rel, value) => {
        bundle.models[`${ns}:${rel.slice(0, -5)}`] = value as BlockModelJson;
      });
    }
  }
  return bundle;
}

export async function readJsonTree(dir: string, onFile: (rel: string, value: unknown) => void): Promise<void> {
  await visitMatchingFiles(dir, '.json', async (rel, file) => {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (isMissingPath(error)) return;
      throw error;
    }
    try {
      onFile(rel, JSON.parse(text));
    } catch {
      // Skip malformed resource files so one bad model does not block profiling.
    }
  });
}
