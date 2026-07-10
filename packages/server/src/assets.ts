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
let bundlePayloadCache: { bundle: AssetBundle; body: string; etag: string } | null = null;
const atlasCache = new Map<string, { png: Uint8Array; manifest: TextureAtlasManifest }>();
const atlasInflight = new Map<string, Promise<{ key: string; manifest: TextureAtlasManifest; png: Uint8Array }>>();
const texturePathCache = new Map<string, string | null>();
const textureCache = new Map<string, { bytes: Uint8Array; etag: string }>();
const textureInflight = new Map<string, Promise<{ bytes: Uint8Array; etag: string } | null>>();
const MAX_ATLAS_TEXTURES = 2048;
const MAX_ATLAS_CACHE_ENTRIES = 8;
const MAX_TEXTURE_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CONCURRENT_ATLAS_BUILDS = 1;
const MAX_QUEUED_ATLAS_BUILDS = 16;
let textureCacheBytes = 0;
let activeAtlasBuilds = 0;
const atlasWaiters: (() => void)[] = [];

async function withAtlasSlot<T>(build: () => Promise<T>): Promise<T> {
  if (activeAtlasBuilds >= MAX_CONCURRENT_ATLAS_BUILDS) {
    if (atlasWaiters.length >= MAX_QUEUED_ATLAS_BUILDS) throw new Error('atlas service is busy; retry shortly');
    await new Promise<void>((resolve) => atlasWaiters.push(resolve));
  }
  activeAtlasBuilds++;
  try {
    return await build();
  } finally {
    activeAtlasBuilds--;
    atlasWaiters.shift()?.();
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await map(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** 扫描资源目录，合并所有命名空间的 blockstates 与 models（后加载的目录覆盖先前）。 */
export async function buildAssetBundle(force = false): Promise<AssetBundle> {
  if (force) {
    bundleCache = null;
    bundlePayloadCache = null;
  }
  if (bundleCache && !force) return bundleCache;
  if (bundlePromise) return bundlePromise;
  const pending = (async () => {
    const bundle: AssetBundle = { blockstates: {}, models: {} };
    for (const dir of config.assetsDirs) {
      let namespaces: string[] = [];
      try {
        namespaces = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
      } catch { continue; }
      for (const ns of namespaces) {
        const bsEntries = await walkJson(path.join(dir, ns, 'blockstates'));
        const modelEntries = await walkJson(path.join(dir, ns, 'models'));
        const reads = [
          ...bsEntries.map(({ rel, file }) => ({ id: `${ns}:${rel.slice(0, -5)}`, file, target: bundle.blockstates })),
          ...modelEntries.map(({ rel, file }) => ({ id: `${ns}:${rel.slice(0, -5)}`, file, target: bundle.models })),
        ];
        await mapWithConcurrency(reads, 32, async ({ id, file, target }) => {
          try { target[id] = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* malformed resource files are skipped */ }
        });
      }
    }
    bundleCache = bundle;
    bundlePayloadCache = null;
    return bundle;
  })();
  bundlePromise = pending;
  try {
    return await pending;
  } finally {
    if (bundlePromise === pending) bundlePromise = null;
  }
}

/** A pre-serialized, validator-tagged bundle avoids JSON.stringify work per viewer. */
export async function getAssetBundlePayload(): Promise<{ body: string; etag: string }> {
  const bundle = await buildAssetBundle();
  if (bundlePayloadCache?.bundle === bundle) return bundlePayloadCache;
  const body = JSON.stringify(bundle);
  const payload = { bundle, body, etag: `"${createHash('sha1').update(body).digest('hex')}"` };
  bundlePayloadCache = payload;
  return payload;
}

export function clearTextureAtlasCache(): void {
  atlasCache.clear();
  atlasInflight.clear();
  texturePathCache.clear();
  textureCache.clear();
  textureInflight.clear();
  textureCacheBytes = 0;
}

const TEXTURE_ID_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;

/** 纹理 id（如 minecraft:block/stone）到文件路径，后加载目录优先。 */
export async function textureFilePath(id: string): Promise<string | null> {
  const nid = normalizeId(id);
  if (!TEXTURE_ID_RE.test(nid) || nid.includes('..')) return null;
  if (texturePathCache.has(nid)) return texturePathCache.get(nid)!;
  const [ns, rest] = nid.split(':');
  for (let i = config.assetsDirs.length - 1; i >= 0; i--) {
    const file = path.join(config.assetsDirs[i], ns, 'textures', `${rest}.png`);
    try {
      await fs.access(file);
      texturePathCache.set(nid, file);
      return file;
    } catch { /* next */ }
  }
  texturePathCache.set(nid, null);
  return null;
}

function rememberTexture(id: string, value: { bytes: Uint8Array; etag: string }): void {
  const previous = textureCache.get(id);
  if (previous) textureCacheBytes -= previous.bytes.byteLength;
  textureCache.delete(id);
  textureCache.set(id, value);
  textureCacheBytes += value.bytes.byteLength;
  while (textureCacheBytes > MAX_TEXTURE_CACHE_BYTES && textureCache.size > 1) {
    const oldest = textureCache.entries().next().value as [string, { bytes: Uint8Array; etag: string }] | undefined;
    if (!oldest) break;
    textureCache.delete(oldest[0]);
    textureCacheBytes -= oldest[1].bytes.byteLength;
  }
}

/** Read a texture once per reload window; callers get an LRU-cached immutable byte buffer. */
export async function readTextureFile(id: string): Promise<{ bytes: Uint8Array; etag: string } | null> {
  const nid = normalizeId(id);
  const cached = textureCache.get(nid);
  if (cached) {
    textureCache.delete(nid);
    textureCache.set(nid, cached);
    return cached;
  }
  const pending = textureInflight.get(nid);
  if (pending) return pending;
  const read = (async () => {
    const file = await textureFilePath(nid);
    if (!file) return null;
    try {
      const bytes = new Uint8Array(await fs.readFile(file));
      const value = { bytes, etag: `"${createHash('sha1').update(bytes).digest('hex')}"` };
      if (bytes.byteLength <= MAX_TEXTURE_CACHE_BYTES) rememberTexture(nid, value);
      return value;
    } catch {
      texturePathCache.delete(nid);
      return null;
    }
  })();
  textureInflight.set(nid, read);
  try {
    return await read;
  } finally {
    if (textureInflight.get(nid) === read) textureInflight.delete(nid);
  }
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
  const texture = await readTextureFile(id);
  if (!texture) return missingTile(tile);
  try {
    const png = PNG.sync.read(Buffer.from(texture.bytes.buffer, texture.bytes.byteOffset, texture.bytes.byteLength));
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

function rememberAtlas(key: string, value: { png: Uint8Array; manifest: TextureAtlasManifest }): void {
  atlasCache.delete(key);
  atlasCache.set(key, value);
  while (atlasCache.size > MAX_ATLAS_CACHE_ENTRIES) atlasCache.delete(atlasCache.keys().next().value!);
}

async function buildTextureAtlasInner(normalized: string[]): Promise<{ key: string; manifest: TextureAtlasManifest; png: Uint8Array }> {
  const tiles = await mapWithConcurrency(normalized, 32, async (id) => id === '__missing__' ? missingTile(16) : readTextureTile(id, 16));
  const hash = createHash('sha1').update(JSON.stringify(normalized));
  for (const tileData of tiles) hash.update(tileData);
  const key = hash.digest('hex').slice(0, 20);
  const hit = atlasCache.get(key);
  if (hit) {
    atlasCache.delete(key);
    atlasCache.set(key, hit);
    return { key, ...hit };
  }

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
  rememberAtlas(key, { png: bytes, manifest });
  return { key, png: bytes, manifest };
}

export async function buildTextureAtlas(ids: string[]): Promise<{ key: string; manifest: TextureAtlasManifest; png: Uint8Array }> {
  // Canonical order makes equivalent client requests share one in-flight build and cache entry.
  const normalized = ['__missing__', ...Array.from(new Set(ids.map(normalizeId))).sort()];
  if (normalized.length - 1 > MAX_ATLAS_TEXTURES) throw new Error(`atlas supports at most ${MAX_ATLAS_TEXTURES} textures`);
  const requestKey = normalized.join('\n');
  const pending = atlasInflight.get(requestKey);
  if (pending) return pending;
  const build = withAtlasSlot(() => buildTextureAtlasInner(normalized));
  atlasInflight.set(requestKey, build);
  try {
    return await build;
  } finally {
    if (atlasInflight.get(requestKey) === build) atlasInflight.delete(requestKey);
  }
}

export function getTextureAtlasPng(key: string): Uint8Array | null {
  const hit = atlasCache.get(key);
  if (!hit) return null;
  atlasCache.delete(key);
  atlasCache.set(key, hit);
  return hit.png;
}
