import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AssetBundle, AtlasIndex, TextureAlphaMap, normalizeId } from '@violet-map/core';
import { PNG } from 'pngjs';
import { config } from './config.js';

type JsonEntry = { rel: string; file: string };

async function walkJson(dir: string, entries: JsonEntry[] = [], rel = ''): Promise<JsonEntry[]> {
  let dirents;
  try { dirents = await fs.readdir(dir, { withFileTypes: true }); } catch { return entries; }
  for (const e of dirents) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walkJson(path.join(dir, e.name), entries, r);
    else if (e.name.endsWith('.json')) entries.push({ rel: r, file: path.join(dir, e.name) });
  }
  return entries;
}

let bundleCache: AssetBundle | null = null;
let bundlePromise: Promise<AssetBundle> | null = null;
const atlasCache = new Map<string, { png: Uint8Array; manifest: TextureAtlasManifest }>();

/** 扫描资源目录，合并所有命名空间的 blockstates 与 models（后加载的目录覆盖先前）。 */
export async function buildAssetBundle(force = false): Promise<AssetBundle> {
  if (bundleCache && !force) return bundleCache;
  if (!force && bundlePromise) return bundlePromise;
  bundlePromise = (async () => {
    const bundle: AssetBundle = { blockstates: {}, models: {} };
    for (const dir of config.assetsDirs) {
      let namespaces: string[] = [];
      try {
        namespaces = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
      } catch { continue; }
      for (const ns of namespaces) {
        const bsEntries = await walkJson(path.join(dir, ns, 'blockstates'));
        const modelEntries = await walkJson(path.join(dir, ns, 'models'));
        const allReads: Promise<void>[] = [];
        for (const { rel, file } of bsEntries) {
          const id = `${ns}:${rel.slice(0, -5)}`;
          allReads.push(
            fs.readFile(file, 'utf8').then((s) => { bundle.blockstates[id] = JSON.parse(s); }).catch(() => {}),
          );
        }
        for (const { rel, file } of modelEntries) {
          const id = `${ns}:${rel.slice(0, -5)}`;
          allReads.push(
            fs.readFile(file, 'utf8').then((s) => { bundle.models[id] = JSON.parse(s); }).catch(() => {}),
          );
        }
        await Promise.all(allReads);
      }
    }
    bundleCache = bundle;
    bundlePromise = null;
    return bundle;
  })();
  return bundlePromise;
}

export function clearTextureAtlasCache(): void {
  atlasCache.clear();
}

const TEXTURE_ID_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;

/** 纹理 id（如 minecraft:block/stone）到文件路径，后加载目录优先。 */
export async function textureFilePath(id: string): Promise<string | null> {
  const nid = normalizeId(id);
  if (!TEXTURE_ID_RE.test(nid) || nid.includes('..')) return null;
  const [ns, rest] = nid.split(':');
  for (let i = config.assetsDirs.length - 1; i >= 0; i--) {
    const file = path.join(config.assetsDirs[i], ns, 'textures', `${rest}.png`);
    try { await fs.access(file); return file; } catch { /* next */ }
  }
  return null;
}

export interface TextureAtlasManifest {
  cacheKey: string;
  image: string;
  width: number;
  height: number;
  index: AtlasIndex;
  avgColors: Record<string, [number, number, number]>;
  hasAlpha: TextureAlphaMap;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function writePixel(data: Uint8Array, width: number, x: number, y: number, r: number, g: number, b: number, a: number) {
  const i = (y * width + x) * 4;
  data[i] = r;
  data[i + 1] = g;
  data[i + 2] = b;
  data[i + 3] = a;
}

function readPixel(data: Uint8Array, width: number, x: number, y: number): [number, number, number, number] {
  const i = (y * width + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

function missingTile(tile: number): Uint8Array {
  const data = new Uint8Array(tile * tile * 4);
  for (let y = 0; y < tile; y++) {
    for (let x = 0; x < tile; x++) {
      const black = (x < tile / 2 && y < tile / 2) || (x >= tile / 2 && y >= tile / 2);
      writePixel(data, tile, x, y, black ? 0 : 248, black ? 0 : 0, black ? 0 : 248, 255);
    }
  }
  return data;
}

async function readTextureTile(id: string, tile: number): Promise<Uint8Array> {
  const file = await textureFilePath(id);
  if (!file) return missingTile(tile);
  try {
    const png = PNG.sync.read(await fs.readFile(file));
    const frame = png.width;
    const out = new Uint8Array(tile * tile * 4);
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        const sx = clamp(Math.floor((x * frame) / tile), 0, png.width - 1);
        const sy = clamp(Math.floor((y * frame) / tile), 0, Math.min(frame, png.height) - 1);
        const [r, g, b, a] = readPixel(png.data, png.width, sx, sy);
        writePixel(out, tile, x, y, r, g, b, a);
      }
    }
    return out;
  } catch {
    return missingTile(tile);
  }
}

function blitPaddedTile(dst: PNG, tileData: Uint8Array, x0: number, y0: number, tile: number, pad: number) {
  const stride = tile + pad * 2;
  for (let y = 0; y < stride; y++) {
    for (let x = 0; x < stride; x++) {
      const sx = clamp(x - pad, 0, tile - 1);
      const sy = clamp(y - pad, 0, tile - 1);
      const [r, g, b, a] = readPixel(tileData, tile, sx, sy);
      writePixel(dst.data, dst.width, x0 + x, y0 + y, r, g, b, a);
    }
  }
}

function tileStats(tileData: Uint8Array): { avg: [number, number, number]; alpha: boolean } {
  let r = 0, g = 0, b = 0, n = 0;
  let alpha = false;
  for (let p = 0; p < tileData.length; p += 4) {
    if (tileData[p + 3] < 250) alpha = true;
    if (tileData[p + 3] < 32) continue;
    r += tileData[p];
    g += tileData[p + 1];
    b += tileData[p + 2];
    n++;
  }
  return { avg: n ? [r / n / 255, g / n / 255, b / n / 255] : [1, 0, 1], alpha };
}

export async function buildTextureAtlas(ids: string[]): Promise<{ key: string; manifest: TextureAtlasManifest; png: Uint8Array }> {
  const normalized = ['__missing__', ...Array.from(new Set(ids.map(normalizeId)))];
  const tiles = await Promise.all(normalized.map((id) => id === '__missing__' ? missingTile(16) : readTextureTile(id, 16)));
  const hash = createHash('sha1').update(JSON.stringify(normalized));
  for (const tileData of tiles) hash.update(tileData);
  const key = hash.digest('hex').slice(0, 20);
  const hit = atlasCache.get(key);
  if (hit) return { key, ...hit };

  const tile = 16;
  const pad = 8;
  const stride = tile + pad * 2;
  const cols = Math.ceil(Math.sqrt(normalized.length));
  let size = 1;
  while (size < cols * stride) size *= 2;

  const png = new PNG({ width: size, height: size, colorType: 6 });
  const index: AtlasIndex = {};
  const avgColors: Record<string, [number, number, number]> = {};
  const hasAlpha: TextureAlphaMap = {};

  normalized.forEach((id, i) => {
    const tileData = tiles[i];
    const x = (i % cols) * stride;
    const y = Math.floor(i / cols) * stride;
    const tx = x + pad;
    const ty = y + pad;
    blitPaddedTile(png, tileData, x, y, tile, pad);
    index[id] = { u0: tx / size, v0: ty / size, u1: (tx + tile) / size, v1: (ty + tile) / size };
    const stats = tileStats(tileData);
    avgColors[id] = stats.avg;
    hasAlpha[id] = stats.alpha;
  });

  const bytes = PNG.sync.write(png);
  const manifest: TextureAtlasManifest = {
    cacheKey: key,
    image: `/api/assets/atlas/${key}`,
    width: size,
    height: size,
    index,
    avgColors,
    hasAlpha,
  };
  atlasCache.set(key, { png: bytes, manifest });
  return { key, png: bytes, manifest };
}

export function getTextureAtlasPng(key: string): Uint8Array | null {
  return atlasCache.get(key)?.png ?? null;
}
