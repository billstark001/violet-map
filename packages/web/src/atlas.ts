import type { AssetBundle, AtlasIndex, BlockInfoMap, BlockModelJson, TextureAlphaMap } from '@violet-map/core';
import { fetchTextureAtlas, textureUrl } from './api';

export interface BuiltAtlas {
  cacheKey: string;
  canvas: HTMLCanvasElement;
  index: AtlasIndex;
  avgColors: Record<string, [number, number, number]>;
  hasAlpha: TextureAlphaMap;
  animations: TextureAnimationData;
}

/** GPU-neutral lookup textures for animated atlas sprites. The worker only
 * receives `ids`; the main thread turns the byte tables into DataTextures. */
export interface TextureAnimationData {
  ids: Record<string, number>;
  info: Uint8Array;
  infoSize: [number, number];
  frames: Uint8Array;
  frameSize: [number, number];
}

function encode16(target: Uint8Array, offset: number, value: number) {
  const n = Math.max(0, Math.min(65535, Math.round(value * 65535)));
  target[offset] = n >> 8;
  target[offset + 1] = n & 0xff;
}

function textureAnimationData(index: AtlasIndex): TextureAnimationData {
  const ids: Record<string, number> = {};
  const sequences: { id: string; frames: { u0: number; v0: number; u1: number; v1: number }[] }[] = [];
  for (const [id, rect] of Object.entries(index).sort(([a], [b]) => a.localeCompare(b))) {
    const animation = rect.animation;
    if (!animation || animation.frames.length < 2) continue;
    const expanded: { u0: number; v0: number; u1: number; v1: number }[] = [];
    for (let i = 0; i < animation.frames.length && expanded.length < 65535; i++) {
      const time = Math.max(1, Math.min(255, Math.floor(animation.times[i] ?? 1)));
      for (let tick = 0; tick < time && expanded.length < 65535; tick++) expanded.push(animation.frames[i]);
    }
    if (expanded.length > 1 && sequences.length < 65535) sequences.push({ id, frames: expanded });
  }
  const infoWidth = 256;
  const infoHeight = Math.max(1, Math.ceil((sequences.length + 1) / infoWidth));
  const info = new Uint8Array(infoWidth * infoHeight * 4);
  const allFrames = sequences.reduce((total, sequence) => total + sequence.frames.length, 0);
  const frameWidth = 256;
  const framePixels = Math.max(1, allFrames * 2);
  const frameHeight = Math.max(1, Math.ceil(framePixels / frameWidth));
  const frames = new Uint8Array(frameWidth * frameHeight * 4);
  let start = 0;
  sequences.forEach((sequence, indexInList) => {
    const id = indexInList + 1;
    ids[sequence.id] = id;
    const infoOffset = id * 4;
    info[infoOffset] = start >> 8;
    info[infoOffset + 1] = start & 0xff;
    info[infoOffset + 2] = sequence.frames.length >> 8;
    info[infoOffset + 3] = sequence.frames.length & 0xff;
    for (const frame of sequence.frames) {
      const first = start * 2;
      const second = first + 1;
      const p0 = (Math.floor(first / frameWidth) * frameWidth + (first % frameWidth)) * 4;
      const p1 = (Math.floor(second / frameWidth) * frameWidth + (second % frameWidth)) * 4;
      encode16(frames, p0, frame.u0); encode16(frames, p0 + 2, frame.v0);
      encode16(frames, p1, frame.u1); encode16(frames, p1 + 2, frame.v1);
      start++;
    }
  });
  return { ids, info, infoSize: [infoWidth, infoHeight], frames, frameSize: [frameWidth, frameHeight] };
}

export function collectTextureIds(bundle: AssetBundle, blockInfo: BlockInfoMap): string[] {
  const ids = new Set<string>();
  const models = new Set<string>();
  const seenModels = new Set<string>();
  const normalize = (id: string) => id.includes(':') ? id : `minecraft:${id}`;
  const add = (v: unknown) => {
    if (v && typeof v === 'object') v = (v as { sprite?: unknown }).sprite;
    if (typeof v !== 'string') return;
    if (!v.startsWith('#')) ids.add(normalize(v));
  };
  const addModel = (v: unknown) => {
    if (v && typeof v === 'object') v = (v as { model?: unknown }).model;
    if (typeof v === 'string') models.add(normalize(v));
  };
  const collectBlockstateModels = (bs: any) => {
    if (bs?.variants) {
      for (const value of Object.values<any>(bs.variants)) {
        if (Array.isArray(value)) value.forEach(addModel);
        else addModel(value);
      }
    }
    if (bs?.multipart) {
      for (const part of bs.multipart as any[]) {
        const apply = part?.apply;
        if (Array.isArray(apply)) apply.forEach(addModel);
        else addModel(apply);
      }
    }
  };
  for (const bs of Object.values(bundle.blockstates)) collectBlockstateModels(bs);
  const collectRenderer = (definition: unknown) => {
    if (!definition || typeof definition !== 'object') return;
    const renderer = definition as {
      model?: unknown;
      texture?: unknown;
      textureByBlock?: unknown;
      variants?: Record<string, unknown>;
    };
    addModel(renderer.model);
    add(renderer.texture);
    if (renderer.textureByBlock && typeof renderer.textureByBlock === 'object') {
      for (const texture of Object.values(renderer.textureByBlock)) add(texture);
    }
    for (const variant of Object.values(renderer.variants ?? {})) collectRenderer(variant);
  };
  for (const definition of Object.values(bundle.renderers?.blockEntities ?? {})) collectRenderer(definition);
  for (const definition of Object.values(bundle.renderers?.entities ?? {})) collectRenderer(definition);

  const visitModel = (id: string) => {
    if (seenModels.has(id)) return;
    seenModels.add(id);
    const model = bundle.models[id] as BlockModelJson | undefined;
    if (!model) return;
    if (model.textures) for (const v of Object.values(model.textures)) add(v);
    if (model.parent) visitModel(normalize(model.parent));
  };
  for (const id of models) {
    visitModel(id);
  }
  for (const info of Object.values(blockInfo)) {
    if (!info.fluid) continue;
    add(info.fluid.texture);
    add(info.fluid.flowTexture);
  }
  return [...ids];
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed: ${url}`));
    img.src = url;
  });
}

function simpleHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** 构建纹理图集。动画贴图（竖长条）只取第一帧。 */
export async function buildAtlas(ids: string[]): Promise<BuiltAtlas> {
  try {
    const manifest = await fetchTextureAtlas(ids);
    const img = await loadImage(manifest.image);
    const canvas = document.createElement('canvas');
    canvas.width = manifest.width;
    canvas.height = manifest.height;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0);
    return {
      cacheKey: manifest.cacheKey ?? manifest.image.split('/').pop() ?? 'server-atlas',
      canvas,
      index: manifest.index,
      avgColors: manifest.avgColors,
      hasAlpha: manifest.hasAlpha,
      animations: textureAnimationData(manifest.index),
    };
  } catch (e) {
    console.warn('batched texture atlas failed; falling back to individual textures', e);
  }

  const PAD = 8;
  const results = await Promise.allSettled(ids.map((id) => loadImage(textureUrl(id))));
  const entries: {
    id: string;
    img: HTMLImageElement | null;
    sourceWidth: number;
    sourceHeight: number;
    width: number;
    height: number;
  }[] = [{ id: '__missing__', img: null, sourceWidth: 16, sourceHeight: 16, width: 16, height: 16 }];
  results.forEach((result, i) => {
    const img = result.status === 'fulfilled' ? result.value : null;
    // Vanilla animated sprites are vertical strips of square frames. Static
    // entity textures (signs, chests, shelves, …) keep their native aspect and
    // resolution so their model UVs remain pixel-accurate.
    const sourceWidth = img?.width ?? 16;
    const sourceHeight = img && img.height > img.width ? img.width : (img?.height ?? 16);
    const scale = Math.min(1, 256 / Math.max(sourceWidth, sourceHeight));
    entries.push({
      id: ids[i],
      img,
      sourceWidth,
      sourceHeight,
      width: Math.max(1, Math.round(sourceWidth * scale)),
      height: Math.max(1, Math.round(sourceHeight * scale)),
    });
  });

  type Placement = { x: number; y: number };
  const tryPack = (size: number): Placement[] | null => {
    const placements: Placement[] = [];
    let x = 0;
    let y = 0;
    let rowHeight = 0;
    for (const entry of entries) {
      const cellWidth = entry.width + PAD * 2;
      const cellHeight = entry.height + PAD * 2;
      if (cellWidth > size || cellHeight > size) return null;
      if (x + cellWidth > size) {
        x = 0;
        y += rowHeight;
        rowHeight = 0;
      }
      if (y + cellHeight > size) return null;
      placements.push({ x, y });
      x += cellWidth;
      rowHeight = Math.max(rowHeight, cellHeight);
    }
    return placements;
  };
  let size = 64;
  let placements = tryPack(size);
  while (!placements && size < 8192) {
    size *= 2;
    placements = tryPack(size);
  }
  if (!placements) throw new Error('client texture atlas exceeds 8192px');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;

  const index: AtlasIndex = {};
  const avgColors: Record<string, [number, number, number]> = {};
  const hasAlpha: TextureAlphaMap = {};

  entries.forEach((e, i) => {
    const { x, y } = placements![i];
    const tx = x + PAD;
    const ty = y + PAD;
    if (e.img) {
      ctx.drawImage(e.img, 0, 0, e.sourceWidth, e.sourceHeight, tx, ty, e.width, e.height);
    } else {
      ctx.fillStyle = '#f800f8'; ctx.fillRect(tx, ty, e.width, e.height);
      ctx.fillStyle = '#000000'; ctx.fillRect(tx, ty, 8, 8); ctx.fillRect(tx + 8, ty + 8, 8, 8);
    }
    ctx.drawImage(canvas, tx, ty, e.width, 1, tx, y, e.width, PAD);
    ctx.drawImage(canvas, tx, ty + e.height - 1, e.width, 1, tx, ty + e.height, e.width, PAD);
    ctx.drawImage(canvas, tx, ty, 1, e.height, x, ty, PAD, e.height);
    ctx.drawImage(canvas, tx + e.width - 1, ty, 1, e.height, tx + e.width, ty, PAD, e.height);
    ctx.drawImage(canvas, tx, ty, 1, 1, x, y, PAD, PAD);
    ctx.drawImage(canvas, tx + e.width - 1, ty, 1, 1, tx + e.width, y, PAD, PAD);
    ctx.drawImage(canvas, tx, ty + e.height - 1, 1, 1, x, ty + e.height, PAD, PAD);
    ctx.drawImage(canvas, tx + e.width - 1, ty + e.height - 1, 1, 1, tx + e.width, ty + e.height, PAD, PAD);
    index[e.id] = { u0: tx / size, v0: ty / size, u1: (tx + e.width) / size, v1: (ty + e.height) / size };
    const data = ctx.getImageData(tx, ty, e.width, e.height).data;
    let r = 0, g = 0, b = 0, n = 0;
    let alpha = false;
    for (let p = 0; p < data.length; p += 4) {
      if (data[p + 3] < 250) alpha = true;
      if (data[p + 3] < 32) continue;
      r += data[p]; g += data[p + 1]; b += data[p + 2]; n++;
    }
    avgColors[e.id] = n ? [r / n / 255, g / n / 255, b / n / 255] : [1, 0, 1];
    hasAlpha[e.id] = alpha;
  });
  const ret: BuiltAtlas = {
    cacheKey: `client-native-v1:${simpleHash(ids.slice().sort().join('\n'))}`,
    canvas,
    index,
    avgColors,
    hasAlpha,
    animations: textureAnimationData(index),
  };
  return ret;
}

/** 载入原版 colormap（256×256 RGBA）。 */
export async function loadColormap(id: string): Promise<Uint8Array | null> {
  try {
    const img = await loadImage(textureUrl(id));
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, 256, 256);
    return new Uint8Array(ctx.getImageData(0, 0, 256, 256).data.buffer);
  } catch {
    return null;
  }
}
