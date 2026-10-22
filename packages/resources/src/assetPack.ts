import { ResourceError } from '@violet-map/core/resources';
import { artifactRef, sha256 } from '@violet-map/storage';
import { actionKey } from './keys.js';

export interface AssetPackOptions {
  assets: { dirs: string[] };
  cache: { textureBytes: number; metadataEntries?: number };
}

import {
  type AssetBundle,
  type AtlasAnimation,
  type AtlasFrameRect,
  type AtlasIndex,
  type TextureAlphaMap,
  type TextureAnimationDef,
} from '@violet-map/core/assets';
import { mapWithConcurrency } from '@violet-map/core/async';
import { LruCache } from '@violet-map/core/cache';
import type { AtlasDocument } from '@violet-map/core/contracts';
import { normalizeId } from '@violet-map/core/domain';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

export function createAssetPack(config: AssetPackOptions) {
  type JsonEntry = { rel: string; file: string };

  function isMissingPath(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }

  async function walkJson(dir: string, entries: JsonEntry[] = [], rel = ''): Promise<JsonEntry[]> {
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isMissingPath(error)) return entries;
      throw error;
    }
    for (const e of dirents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walkJson(path.join(dir, e.name), entries, r);
      else if (e.name.endsWith('.json')) {
        if (entries.length >= 32768) throw new ResourceError('RESOURCE_BUSY', 'asset JSON inventory exceeds budget');
        entries.push({ rel: r, file: path.join(dir, e.name) });
      }
    }
    return entries;
  }

  async function walkAnimationMeta(dir: string, entries: JsonEntry[] = [], rel = ''): Promise<JsonEntry[]> {
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isMissingPath(error)) return entries;
      throw error;
    }
    for (const e of dirents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walkAnimationMeta(path.join(dir, e.name), entries, r);
      else if (e.isFile() && e.name.endsWith('.png.mcmeta')) {
        if (entries.length >= 32768) throw new ResourceError('RESOURCE_BUSY', 'animation inventory exceeds budget');
        entries.push({ rel: r, file: path.join(dir, e.name) });
      }
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
    return {
      frametime,
      ...(frames?.length ? { frames } : {}),
      ...(raw.interpolate === true ? { interpolate: true } : {}),
    };
  }

  let bundlePromise: Promise<AssetBundle> | null = null;
  const texturePathCache = new LruCache<string, string | null>({ maxEntries: config.cache.metadataEntries ?? 16384 });
  const textureCache = new LruCache<string, { bytes: Uint8Array }>({
    maxEntries: 4096,
    maxWeight: config.cache.textureBytes,
    weightOf: (entry) => entry.bytes.byteLength,
  });
  const textureInflight = new Map<string, Promise<{ bytes: Uint8Array } | null>>();
  const MAX_ATLAS_TEXTURES = 2048;
  const MAX_TEXTURE_CACHE_BYTES = config.cache.textureBytes;
  const BUNDLED_RENDERER_ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../data-defaults/assets');
  let textureGeneration = 0;

  /** 扫描资源目录，合并所有命名空间的 blockstates 与 models（后加载的目录覆盖先前）。 */
  async function buildAssetBundle(force = false): Promise<AssetBundle> {
    if (force) {
      bundlePromise = null;
    }
    if (bundlePromise) return bundlePromise;
    const pending = (async () => {
      let inputBytes = 0;
      let inputFiles = 0;
      const readJson = async (file: string): Promise<any> => {
        const handle = await fs.open(file, 'r');
        try {
          const { size } = await handle.stat();
          if (++inputFiles > 32768 || size > 8 * 1024 ** 2 - inputBytes)
            throw new ResourceError('RESOURCE_BUSY', 'asset JSON inputs exceed the bundle work budget');
          inputBytes += size;
          const bytes = new Uint8Array(size);
          const result = await handle.read(bytes, 0, size, 0);
          if (result.bytesRead !== size || (await handle.stat()).size !== size)
            throw new ResourceError('SOURCE_SNAPSHOT_CHANGED', 'asset JSON changed during read', true);
          return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } finally {
          await handle.close();
        }
      };
      const bundle: AssetBundle = { blockstates: {}, models: {}, renderers: {}, textureAnimations: {} };
      // Keep renderer registrations available even for deployments that set
      // ASSETS_DIRS explicitly (which otherwise replaces config defaults).
      // User assets follow the bundled directory and can override any model or
      // registration normally.
      for (const dir of [...new Set([BUNDLED_RENDERER_ASSETS, ...config.assets.dirs])]) {
        let namespaces: string[] = [];
        try {
          namespaces = (await fs.readdir(dir, { withFileTypes: true }))
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
        } catch (error) {
          if (isMissingPath(error)) continue;
          throw error;
        }
        for (const ns of namespaces) {
          const bsEntries = await walkJson(path.join(dir, ns, 'blockstates'));
          const modelEntries = await walkJson(path.join(dir, ns, 'models'));
          const reads = [
            ...bsEntries.map(({ rel, file }) => ({
              id: `${ns}:${rel.slice(0, -5)}`,
              file,
              target: bundle.blockstates,
            })),
            ...modelEntries.map(({ rel, file }) => ({ id: `${ns}:${rel.slice(0, -5)}`, file, target: bundle.models })),
          ];
          await mapWithConcurrency(reads, 32, async ({ id, file, target }) => {
            try {
              target[id] = await readJson(file);
            } catch (error) {
              if (error instanceof ResourceError) throw error;
              throw new Error(`invalid asset JSON: ${file}`, { cause: error });
            }
          });
          try {
            const renderers = (await readJson(
              path.join(dir, ns, 'violet_map', 'renderers.json'),
            )) as AssetBundle['renderers'];
            if (renderers?.blockEntities)
              bundle.renderers!.blockEntities = { ...bundle.renderers!.blockEntities, ...renderers.blockEntities };
            if (renderers?.entities)
              bundle.renderers!.entities = { ...bundle.renderers!.entities, ...renderers.entities };
          } catch (error) {
            if (!isMissingPath(error)) throw error;
          }
          const animationFiles = await walkAnimationMeta(path.join(dir, ns, 'textures'));
          await mapWithConcurrency(animationFiles, 32, async ({ rel, file }) => {
            try {
              const definition = parseAnimationDef(await readJson(file));
              if (definition) bundle.textureAnimations![`${ns}:${rel.slice(0, -'.png.mcmeta'.length)}`] = definition;
            } catch (error) {
              if (error instanceof ResourceError) throw error;
              throw new Error(`invalid animation metadata: ${file}`, { cause: error });
            }
          });
        }
      }
      if (!Object.keys(bundle.renderers!.blockEntities ?? {}).length) delete bundle.renderers!.blockEntities;
      if (!Object.keys(bundle.renderers!.entities ?? {}).length) delete bundle.renderers!.entities;
      if (!Object.keys(bundle.renderers!).length) delete bundle.renderers;
      if (!Object.keys(bundle.textureAnimations!).length) delete bundle.textureAnimations;

      return bundle;
    })();
    bundlePromise = pending;
    try {
      return await pending;
    } finally {
      if (bundlePromise === pending) bundlePromise = null;
    }
  }

  function clearTextureAtlasCache(): void {
    textureGeneration++;
    texturePathCache.clear();
    textureCache.clear();
    textureInflight.clear();
  }

  const TEXTURE_ID_RE = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;

  /** 纹理 id（如 minecraft:block/stone）到文件路径，后加载目录优先。 */
  async function textureFilePath(id: string): Promise<string | null> {
    const nid = normalizeId(id);
    if (!TEXTURE_ID_RE.test(nid) || nid.includes('..')) return null;
    if (texturePathCache.has(nid)) return texturePathCache.get(nid)!;
    const generation = textureGeneration;
    const [ns, rest] = nid.split(':');
    for (let i = config.assets.dirs.length - 1; i >= 0; i--) {
      const file = path.join(config.assets.dirs[i], ns, 'textures', `${rest}.png`);
      try {
        await fs.access(file);
        if (generation === textureGeneration) texturePathCache.set(nid, file);
        return file;
      } catch (error) {
        if (!isMissingPath(error)) throw error;
      }
    }
    if (generation === textureGeneration) texturePathCache.set(nid, null);
    return null;
  }

  /** Read a texture once per reload window; callers get an LRU-cached immutable byte buffer. */
  async function readTextureFile(id: string): Promise<{ bytes: Uint8Array } | null> {
    const nid = normalizeId(id);
    const cached = textureCache.get(nid);
    if (cached) return cached;
    const pending = textureInflight.get(nid);
    if (pending) return pending;
    const generation = textureGeneration;
    const read = (async () => {
      const file = await textureFilePath(nid);
      if (!file) return null;
      try {
        const handle = await fs.open(file, 'r');
        let bytes: Uint8Array;
        try {
          const stat = await handle.stat();
          if (stat.size > MAX_SOURCE_TEXTURE_BYTES)
            throw new ResourceError('RESOURCE_BUSY', 'texture input exceeds source read budget');
          const buffer = new Uint8Array(stat.size);
          const read = await handle.read(buffer, 0, buffer.length, 0);
          if (read.bytesRead !== buffer.length || (await handle.stat()).size !== stat.size)
            throw new ResourceError('SOURCE_SNAPSHOT_CHANGED', 'texture changed during read', true);
          bytes = buffer;
        } finally {
          await handle.close();
        }
        const value = { bytes };
        if (generation === textureGeneration && bytes.byteLength <= MAX_TEXTURE_CACHE_BYTES)
          textureCache.set(nid, value);
        return value;
      } catch (error) {
        if (!isMissingPath(error)) throw error;
        if (generation === textureGeneration) texturePathCache.delete(nid);
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

  function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
  }

  function writePixel(
    data: Uint8Array,
    width: number,
    x: number,
    y: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ) {
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

  interface TextureTile {
    data: Uint8Array;
    width: number;
    height: number;
  }

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

  interface TextureFrames {
    tiles: TextureTile[];
    times: number[];
    interpolate: boolean;
  }

  function blendTiles(from: TextureTile, to: TextureTile, amount: number): TextureTile {
    const data = new Uint8Array(from.data.length);
    const inverse = 1 - amount;
    for (let i = 0; i < data.length; i++) data[i] = Math.round(from.data[i] * inverse + to.data[i] * amount);
    return { data, width: from.width, height: from.height };
  }

  const MAX_ATLAS_SPRITE_SIZE = 256;
  const MAX_SOURCE_TEXTURE_BYTES = 32 * 1024 * 1024;
  const MAX_SOURCE_TEXTURE_DIMENSION = 4096;
  const MAX_SOURCE_TEXTURE_PIXELS = MAX_SOURCE_TEXTURE_DIMENSION ** 2;
  const MAX_SPRITE_SAMPLED_PIXELS = 2 * 1024 * 1024;
  const MAX_ATLAS_SAMPLED_PIXELS = 4 * 1024 * 1024;
  const MAX_PARALLEL_ATLAS_TEXTURE_READS = 4;

  function scaledDimensions(width: number, height: number): [number, number] {
    const scale = Math.min(1, MAX_ATLAS_SPRITE_SIZE / Math.max(width, height));
    return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
  }

  function sampleTile(
    png: PNG,
    sourceX: number,
    sourceY: number,
    sourceWidth: number,
    sourceHeight: number,
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

  async function readTextureFrames(
    id: string,
    def: TextureAnimationDef | undefined,
    texture: { bytes: Uint8Array } | null,
  ): Promise<TextureFrames> {
    if (!texture) return { tiles: [missingTile()], times: [1], interpolate: false };
    try {
      if (texture.bytes.byteLength > MAX_SOURCE_TEXTURE_BYTES || texture.bytes.byteLength < 24)
        throw new Error('texture PNG size is outside atlas limits');
      const header = new DataView(texture.bytes.buffer, texture.bytes.byteOffset, texture.bytes.byteLength);
      const sourceWidth = header.getUint32(16);
      const sourceHeight = header.getUint32(20);
      if (
        !sourceWidth ||
        !sourceHeight ||
        sourceWidth > MAX_SOURCE_TEXTURE_DIMENSION ||
        sourceHeight > MAX_SOURCE_TEXTURE_DIMENSION ||
        sourceWidth * sourceHeight > MAX_SOURCE_TEXTURE_PIXELS
      )
        throw new Error('texture PNG dimensions exceed atlas limits');
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
      const [sampledWidth, sampledHeight] = scaledDimensions(frameSize, frameSize);
      const maxSampledFrames = Math.max(1, Math.floor(MAX_SPRITE_SAMPLED_PIXELS / (sampledWidth * sampledHeight)));
      const frames = declared.slice(0, Math.min(512, maxSampledFrames)).map((entry) => ({
        index: Math.min(available - 1, Math.max(0, entry.index)),
        time: Math.max(1, Math.min(255, entry.time ?? def?.frametime ?? 1)),
      }));
      const tiles = frames.map(({ index }) => sampleTile(png, 0, index * frameSize, frameSize, frameSize));
      if (def.interpolate && tiles.length > 1) {
        if (frames.reduce((total, frame) => total + frame.time, 0) > Math.min(4096, maxSampledFrames))
          return { tiles, times: frames.map((frame) => frame.time), interpolate: false };
        // Minecraft's interpolated sprites blend within a frame duration. Bake
        // those 20-tick subframes into the atlas so the normal frame selector
        // remains compact and every WebGL target gets the same result.
        const interpolated: TextureTile[] = [];
        for (let i = 0; i < tiles.length; i++) {
          const duration = frames[i].time;
          const next = tiles[(i + 1) % tiles.length];
          for (let tick = 0; tick < duration; tick++) {
            interpolated.push(blendTiles(tiles[i], next, tick / duration));
          }
        }
        return {
          tiles: interpolated.length ? interpolated : tiles,
          times: new Array(interpolated.length).fill(1),
          interpolate: false,
        };
      }
      return { tiles: tiles.length ? tiles : [missingTile()], times: frames.map((f) => f.time), interpolate: false };
    } catch (error) {
      throw new ResourceError(
        'RESOURCE_INTEGRITY_FAILED',
        `invalid source PNG: ${id}: ${error instanceof Error ? error.message : 'decode failed'}`,
      );
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
    let r = 0,
      g = 0,
      b = 0,
      n = 0;
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

  interface PackedTile {
    x: number;
    y: number;
  }

  function packTiles(tiles: TextureTile[], pad: number): { size: number; placements: PackedTile[] } {
    const area = tiles.reduce((sum, tile) => sum + (tile.width + pad * 2) * (tile.height + pad * 2), 0);
    const widest = tiles.reduce((max, tile) => Math.max(max, tile.width + pad * 2), 1);
    let width = 1;
    while (width < widest || width * width < area) width *= 2;

    const layout = (atlasWidth: number): { height: number; placements: PackedTile[] } => {
      const placements: PackedTile[] = [];
      let x = 0,
        y = 0,
        rowHeight = 0;
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

  async function buildTextureAtlasInner(
    normalized: string[],
    textures: ({ bytes: Uint8Array } | null)[],
    textureAnimations: AssetBundle['textureAnimations'],
    key: string,
  ): Promise<{ key: string; manifest: AtlasDocument; png: Uint8Array }> {
    let sampledPixels = 0;
    const sprites = await mapWithConcurrency(normalized, MAX_PARALLEL_ATLAS_TEXTURE_READS, async (id, textureIndex) => {
      const sprite =
        id === '__missing__'
          ? { tiles: [missingTile()], times: [1], interpolate: false }
          : await readTextureFrames(id, textureAnimations?.[id], textures[textureIndex]);
      sampledPixels += sprite.tiles.reduce((total, tile) => total + tile.width * tile.height, 0);
      if (sampledPixels > MAX_ATLAS_SAMPLED_PIXELS) throw new Error('texture atlas source pixels exceed budget');
      return sprite;
    });
    const pad = 8;
    const allTiles = sprites.flatMap((sprite) => sprite.tiles);
    const { size, placements } = packTiles(allTiles, pad);

    if (size * size * 4 > 32 * 1024 ** 2)
      throw new ResourceError('RESOURCE_BUSY', 'atlas canvas exceeds reserved work memory');
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
          u0: tx / size,
          v0: ty / size,
          u1: (tx + tile.width) / size,
          v1: (ty + tile.height) / size,
        });
        firstStats ??= tileStats(tile);
        tileIndex++;
      }
      const first = frameRects[0];
      const animation: AtlasAnimation | undefined =
        frameRects.length > 1
          ? { frames: frameRects, times: sprites[sprite].times, interpolate: sprites[sprite].interpolate || undefined }
          : undefined;
      index[id] = { ...first, ...(animation ? { animation } : {}) };
      avgColors[id] = firstStats?.avg ?? [1, 0, 1];
      hasAlpha[id] = firstStats?.alpha ?? true;
    });

    const bytes = PNG.sync.write(png);
    const manifest: AtlasDocument = {
      schemaVersion: 1,
      image: artifactRef(bytes, 'image/png', 'png'),
      width: size,
      height: size,
      index,
      avgColors,
      hasAlpha,
    };
    return { key, png: bytes, manifest };
  }

  async function prepareTextureAtlas(ids: string[], bundle?: AssetBundle) {
    const normalized = [
      '__missing__',
      ...Array.from(new Set(ids.map(normalizeId)))
        .filter((id) => id !== '__missing__')
        .sort(),
    ];
    if (normalized.length - 1 > MAX_ATLAS_TEXTURES) throw new RangeError('atlas texture set exceeds limits');
    const textureAnimations = (bundle ?? (await buildAssetBundle())).textureAnimations;
    const textures: ({ bytes: Uint8Array } | null)[] = [];
    let inputBytes = 0,
      decodedBytes = 0;
    for (const id of normalized) {
      const texture = id === '__missing__' ? null : await readTextureFile(id);
      inputBytes += texture?.bytes.byteLength ?? 0;
      if (inputBytes > 32 * 1024 ** 2)
        throw new ResourceError('RESOURCE_BUSY', 'atlas input exceeds source work budget');
      if (texture) {
        if (texture.bytes.length < 24) throw new ResourceError('RESOURCE_INTEGRITY_FAILED', 'invalid texture PNG');
        const header = new DataView(texture.bytes.buffer, texture.bytes.byteOffset, texture.bytes.byteLength);
        decodedBytes += header.getUint32(16) * header.getUint32(20) * 4;
        if (decodedBytes > 64 * 1024 ** 2)
          throw new ResourceError('RESOURCE_BUSY', 'atlas decoded inputs exceed work budget');
      }
      textures.push(texture);
    }
    const dependencies = normalized.map((id, i) => ({
      role: id,
      digest: sha256(textures[i]?.bytes ?? new TextEncoder().encode('missing-sprite-v1')),
    }));
    const key = actionKey({
      generator: 'atlas',
      version: 1,
      format: 'atlas-v1',
      params: { ids: normalized, animations: JSON.parse(JSON.stringify(textureAnimations ?? {})), padding: 8 },
      dependencies,
    });
    const input = Object.freeze({ normalized, textures, textureAnimations, key });
    return {
      key,
      input,
      async generate() {
        return buildTextureAtlasInner(input.normalized, input.textures, input.textureAnimations, input.key);
      },
    };
  }
  async function textureIds(): Promise<string[]> {
    const ids = new Set<string>();
    for (const dir of config.assets.dirs) {
      let namespaces;
      try {
        namespaces = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (isMissingPath(error)) continue;
        throw error;
      }
      for (const ns of namespaces.filter((entry) => entry.isDirectory())) {
        const walk = async (directory: string, relative = '') => {
          let children;
          try {
            children = await fs.readdir(directory, { withFileTypes: true });
          } catch (error) {
            if (isMissingPath(error)) return;
            throw error;
          }
          for (const child of children) {
            const rel = relative ? relative + '/' + child.name : child.name;
            if (child.isDirectory()) await walk(path.join(directory, child.name), rel);
            else if (child.isFile() && child.name.endsWith('.png')) ids.add(ns.name + ':' + rel.slice(0, -4));
          }
        };
        await walk(path.join(dir, ns.name, 'textures'));
      }
    }
    if (ids.size > 16384)
      throw new ResourceError('RESOURCE_BUSY', 'resource pack texture catalog exceeds metadata budget');
    return [...ids].sort();
  }
  return {
    MAX_ATLAS_TEXTURES,
    textureIds,
    buildAssetBundle,
    clearTextureAtlasCache,
    textureFilePath,
    sourceRevision: async () =>
      (await import('./assetDigest.js')).assetDirectoryRevision([BUNDLED_RENDERER_ASSETS, ...config.assets.dirs]),
    readTextureFile,
    prepareTextureAtlas,
  };
}

export type AssetPack = ReturnType<typeof createAssetPack>;
