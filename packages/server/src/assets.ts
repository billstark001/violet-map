import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AssetBundle, AtlasAnimation, AtlasFrameRect, AtlasIndex, TextureAlphaMap, TextureAnimationDef, normalizeId,
} from '@violet-map/core';
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

async function walkAnimationMeta(dir: string, entries: JsonEntry[] = [], rel = ''): Promise<JsonEntry[]> {
  let dirents;
  try { dirents = await fs.readdir(dir, { withFileTypes: true }); } catch { return entries; }
  for (const e of dirents) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walkAnimationMeta(path.join(dir, e.name), entries, r);
    else if (e.isFile() && e.name.endsWith('.png.mcmeta')) entries.push({ rel: r, file: path.join(dir, e.name) });
  }
  return entries;
}

function parseAnimationDef(value: unknown): TextureAnimationDef | null {
  const animation = value && typeof value === 'object' ? (value as { animation?: unknown }).animation : null;
  if (!animation || typeof animation !== 'object' || Array.isArray(animation)) return null;
  const raw = animation as { frametime?: unknown; frames?: unknown; interpolate?: unknown };
  const frametime = Number.isFinite(raw.frametime) ? Math.max(1, Math.floor(Number(raw.frametime))) : 1;
  const frames = Array.isArray(raw.frames)
    ? raw.frames.flatMap((frame) => {
      if (Number.isFinite(frame)) return [{ index: Math.max(0, Math.floor(Number(frame))) }];
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return [];
      const f = frame as { index?: unknown; time?: unknown };
      if (!Number.isFinite(f.index)) return [];
      const time = Number.isFinite(f.time) ? Math.max(1, Math.floor(Number(f.time))) : undefined;
      return [{ index: Math.max(0, Math.floor(Number(f.index))), ...(time === undefined ? {} : { time }) }];
    })
    : undefined;
  return { frametime, ...(frames?.length ? { frames } : {}), ...(raw.interpolate === true ? { interpolate: true } : {}) };
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
const BUNDLED_RENDERER_ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../data-defaults/assets');
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
    const bundle: AssetBundle = { blockstates: {}, models: {}, renderers: {}, textureAnimations: {} };
    // Keep renderer registrations available even for deployments that set
    // ASSETS_DIRS explicitly (which otherwise replaces config defaults).
    // User assets follow the bundled directory and can override any model or
    // registration normally.
    for (const dir of [...new Set([BUNDLED_RENDERER_ASSETS, ...config.assetsDirs])]) {
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
        try {
          const renderers = JSON.parse(await fs.readFile(path.join(dir, ns, 'violet_map', 'renderers.json'), 'utf8')) as AssetBundle['renderers'];
          if (renderers?.blockEntities) bundle.renderers!.blockEntities = { ...bundle.renderers!.blockEntities, ...renderers.blockEntities };
          if (renderers?.entities) bundle.renderers!.entities = { ...bundle.renderers!.entities, ...renderers.entities };
        } catch {
          // Renderer resources are optional and intentionally use a dedicated
          // namespace path so normal Java resource packs remain valid.
        }
        const animationFiles = await walkAnimationMeta(path.join(dir, ns, 'textures'));
        await mapWithConcurrency(animationFiles, 32, async ({ rel, file }) => {
          try {
            const definition = parseAnimationDef(JSON.parse(await fs.readFile(file, 'utf8')));
            if (definition) bundle.textureAnimations![`${ns}:${rel.slice(0, -'.png.mcmeta'.length)}`] = definition;
          } catch { /* malformed sidecars are ignored like model JSON */ }
        });
      }
    }
    if (!Object.keys(bundle.renderers!.blockEntities ?? {}).length) delete bundle.renderers!.blockEntities;
    if (!Object.keys(bundle.renderers!.entities ?? {}).length) delete bundle.renderers!.entities;
    if (!Object.keys(bundle.renderers!).length) delete bundle.renderers;
    if (!Object.keys(bundle.textureAnimations!).length) delete bundle.textureAnimations;
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

interface TextureTile { data: Uint8Array; width: number; height: number }

function missingTile(size = 16): TextureTile {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const black = (x < size / 2 && y < size / 2) || (x >= size / 2 && y >= size / 2);
      writePixel(data, size, x, y, black ? 0 : 248, black ? 0 : 0, black ? 0 : 248, 255);
    }
  }
  return { data, width: size, height: size };
}

interface TextureFrames { tiles: TextureTile[]; times: number[]; interpolate: boolean }

function blendTiles(from: TextureTile, to: TextureTile, amount: number): TextureTile {
  const data = new Uint8Array(from.data.length);
  const inverse = 1 - amount;
  for (let i = 0; i < data.length; i++) data[i] = Math.round(from.data[i] * inverse + to.data[i] * amount);
  return { data, width: from.width, height: from.height };
}

const MAX_ATLAS_SPRITE_SIZE = 256;

function scaledDimensions(width: number, height: number): [number, number] {
  const scale = Math.min(1, MAX_ATLAS_SPRITE_SIZE / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

function sampleTile(
  png: PNG, sourceX: number, sourceY: number, sourceWidth: number, sourceHeight: number,
): TextureTile {
  const [width, height] = scaledDimensions(sourceWidth, sourceHeight);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = clamp(sourceX + Math.floor((x * sourceWidth) / width), sourceX, sourceX + sourceWidth - 1);
      const sy = clamp(sourceY + Math.floor((y * sourceHeight) / height), sourceY, sourceY + sourceHeight - 1);
      const [r, g, b, a] = readPixel(png.data, png.width, sx, sy);
      writePixel(data, width, x, y, r, g, b, a);
    }
  }
  return { data, width, height };
}

async function readTextureFrames(id: string, def?: TextureAnimationDef): Promise<TextureFrames> {
  const texture = await readTextureFile(id);
  if (!texture) return { tiles: [missingTile()], times: [1], interpolate: false };
  try {
    const png = PNG.sync.read(Buffer.from(texture.bytes.buffer, texture.bytes.byteOffset, texture.bytes.byteLength));
    if (!def) {
      // Static entity skins (signs are 64x32, chests are 64x64) and higher
      // resolution block textures must retain their native aspect and sample
      // density. Treating every PNG as a square animation frame cropped signs
      // and enlarged 32px shelf textures by 200%.
      return { tiles: [sampleTile(png, 0, 0, png.width, png.height)], times: [1], interpolate: false };
    }
    const frameSize = Math.max(1, Math.min(png.width, png.height));
    const available = Math.max(1, Math.floor(png.height / frameSize));
    const declared: { index: number; time?: number }[] = def.frames?.length
      ? def.frames
      : Array.from({ length: available }, (_, index) => ({ index }));
    // A malformed sidecar must not turn an atlas request into an unbounded
    // allocation. Vanilla animations are far below this limit.
    const frames = declared.slice(0, 512).map((entry) => ({
      index: Math.min(available - 1, Math.max(0, entry.index)),
      time: Math.max(1, Math.min(255, entry.time ?? def?.frametime ?? 1)),
    }));
    const tiles = frames.map(({ index }) => sampleTile(png, 0, index * frameSize, frameSize, frameSize));
    if (def.interpolate && tiles.length > 1) {
      // Minecraft's interpolated sprites blend within a frame duration. Bake
      // those 20-tick subframes into the atlas so the normal frame selector
      // remains compact and every WebGL target gets the same result.
      const interpolated: TextureTile[] = [];
      for (let i = 0; i < tiles.length && interpolated.length < 4096; i++) {
        const duration = frames[i].time;
        const next = tiles[(i + 1) % tiles.length];
        for (let tick = 0; tick < duration && interpolated.length < 4096; tick++) {
          interpolated.push(blendTiles(tiles[i], next, tick / duration));
        }
      }
      return { tiles: interpolated.length ? interpolated : tiles, times: new Array(interpolated.length).fill(1), interpolate: false };
    }
    return { tiles: tiles.length ? tiles : [missingTile()], times: frames.map((f) => f.time), interpolate: false };
  } catch {
    return { tiles: [missingTile()], times: [1], interpolate: false };
  }
}

function blitPaddedTile(dst: PNG, tile: TextureTile, x0: number, y0: number, pad: number) {
  const strideWidth = tile.width + pad * 2;
  const strideHeight = tile.height + pad * 2;
  for (let y = 0; y < strideHeight; y++) {
    for (let x = 0; x < strideWidth; x++) {
      const sx = clamp(x - pad, 0, tile.width - 1);
      const sy = clamp(y - pad, 0, tile.height - 1);
      const [r, g, b, a] = readPixel(tile.data, tile.width, sx, sy);
      writePixel(dst.data, dst.width, x0 + x, y0 + y, r, g, b, a);
    }
  }
}

function tileStats(tile: TextureTile): { avg: [number, number, number]; alpha: boolean } {
  let r = 0, g = 0, b = 0, n = 0;
  let alpha = false;
  for (let p = 0; p < tile.data.length; p += 4) {
    if (tile.data[p + 3] < 250) alpha = true;
    if (tile.data[p + 3] < 32) continue;
    r += tile.data[p];
    g += tile.data[p + 1];
    b += tile.data[p + 2];
    n++;
  }
  return { avg: n ? [r / n / 255, g / n / 255, b / n / 255] : [1, 0, 1], alpha };
}

interface PackedTile { x: number; y: number }

function packTiles(tiles: TextureTile[], pad: number): { size: number; placements: PackedTile[] } {
  const area = tiles.reduce((sum, tile) => sum + (tile.width + pad * 2) * (tile.height + pad * 2), 0);
  const widest = tiles.reduce((max, tile) => Math.max(max, tile.width + pad * 2), 1);
  let width = 1;
  while (width < widest || width * width < area) width *= 2;

  const layout = (atlasWidth: number): { height: number; placements: PackedTile[] } => {
    const placements: PackedTile[] = [];
    let x = 0, y = 0, rowHeight = 0;
    for (const tile of tiles) {
      const cellWidth = tile.width + pad * 2;
      const cellHeight = tile.height + pad * 2;
      if (x > 0 && x + cellWidth > atlasWidth) {
        x = 0;
        y += rowHeight;
        rowHeight = 0;
      }
      placements.push({ x, y });
      x += cellWidth;
      rowHeight = Math.max(rowHeight, cellHeight);
    }
    return { height: y + rowHeight, placements };
  };

  let packed = layout(width);
  while (packed.height > width) {
    width *= 2;
    packed = layout(width);
  }
  if (width > 8192) throw new Error(`texture atlas exceeds 8192px: ${width}`);
  return { size: width, placements: packed.placements };
}

function rememberAtlas(key: string, value: { png: Uint8Array; manifest: TextureAtlasManifest }): void {
  atlasCache.delete(key);
  atlasCache.set(key, value);
  while (atlasCache.size > MAX_ATLAS_CACHE_ENTRIES) atlasCache.delete(atlasCache.keys().next().value!);
}

async function buildTextureAtlasInner(normalized: string[]): Promise<{ key: string; manifest: TextureAtlasManifest; png: Uint8Array }> {
  const textureAnimations = (await buildAssetBundle()).textureAnimations;
  const sprites = await mapWithConcurrency(normalized, 32, async (id) => id === '__missing__'
    ? { tiles: [missingTile()], times: [1], interpolate: false }
    : readTextureFrames(id, textureAnimations?.[id]));
  const hash = createHash('sha1').update(JSON.stringify(normalized));
  for (const sprite of sprites) {
    hash.update(JSON.stringify({ times: sprite.times, interpolate: sprite.interpolate }));
    for (const tile of sprite.tiles) {
      hash.update(JSON.stringify([tile.width, tile.height]));
      hash.update(tile.data);
    }
  }
  const key = hash.digest('hex').slice(0, 20);
  const hit = atlasCache.get(key);
  if (hit) {
    atlasCache.delete(key);
    atlasCache.set(key, hit);
    return { key, ...hit };
  }

  const pad = 8;
  const allTiles = sprites.flatMap((sprite) => sprite.tiles);
  const { size, placements } = packTiles(allTiles, pad);

  const png = new PNG({ width: size, height: size, colorType: 6 });
  const index: AtlasIndex = {};
  const avgColors: Record<string, [number, number, number]> = {};
  const hasAlpha: TextureAlphaMap = {};

  let tileIndex = 0;
  normalized.forEach((id, sprite) => {
    const frameRects: AtlasFrameRect[] = [];
    let firstStats: ReturnType<typeof tileStats> | null = null;
    for (const tile of sprites[sprite].tiles) {
      const { x, y } = placements[tileIndex];
      const tx = x + pad;
      const ty = y + pad;
      blitPaddedTile(png, tile, x, y, pad);
      frameRects.push({
        u0: tx / size, v0: ty / size,
        u1: (tx + tile.width) / size, v1: (ty + tile.height) / size,
      });
      firstStats ??= tileStats(tile);
      tileIndex++;
    }
    const first = frameRects[0];
    const animation: AtlasAnimation | undefined = frameRects.length > 1
      ? { frames: frameRects, times: sprites[sprite].times, interpolate: sprites[sprite].interpolate || undefined }
      : undefined;
    index[id] = { ...first, ...(animation ? { animation } : {}) };
    avgColors[id] = firstStats?.avg ?? [1, 0, 1];
    hasAlpha[id] = firstStats?.alpha ?? true;
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
