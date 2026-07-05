import type { AssetBundle, AtlasIndex, BlockInfoMap, BlockModelJson, TextureAlphaMap } from '@violet-map/core';
import { textureUrl } from './api';

export interface BuiltAtlas {
  canvas: HTMLCanvasElement;
  index: AtlasIndex;
  avgColors: Record<string, [number, number, number]>;
  hasAlpha: TextureAlphaMap;
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
  for (const info of Object.values(blockInfo)) if (info.fluid) add(info.fluid.texture);
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

/** 构建 16px 网格图集。动画贴图（竖长条）只取第一帧。 */
export async function buildAtlas(ids: string[]): Promise<BuiltAtlas> {
  const TILE = 16;
  const PAD = 1;
  const STRIDE = TILE + PAD * 2;
  const results = await Promise.allSettled(ids.map((id) => loadImage(textureUrl(id))));
  const entries: { id: string; img: HTMLImageElement | null }[] = [{ id: '__missing__', img: null }];
  results.forEach((r, i) => entries.push({ id: ids[i], img: r.status === 'fulfilled' ? r.value : null }));

  const cols = Math.ceil(Math.sqrt(entries.length));
  let size = 1;
  while (size < cols * STRIDE) size *= 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;

  const index: AtlasIndex = {};
  const avgColors: Record<string, [number, number, number]> = {};
  const hasAlpha: TextureAlphaMap = {};

  entries.forEach((e, i) => {
    const x = (i % cols) * STRIDE;
    const y = Math.floor(i / cols) * STRIDE;
    const tx = x + PAD;
    const ty = y + PAD;
    if (e.img) {
      const w = e.img.width;
      ctx.drawImage(e.img, 0, 0, w, w, tx, ty, TILE, TILE);
    } else {
      ctx.fillStyle = '#f800f8'; ctx.fillRect(tx, ty, TILE, TILE);
      ctx.fillStyle = '#000000'; ctx.fillRect(tx, ty, 8, 8); ctx.fillRect(tx + 8, ty + 8, 8, 8);
    }
    ctx.drawImage(canvas, tx, ty, TILE, 1, tx, y, TILE, PAD);
    ctx.drawImage(canvas, tx, ty + TILE - 1, TILE, 1, tx, ty + TILE, TILE, PAD);
    ctx.drawImage(canvas, tx, ty, 1, TILE, x, ty, PAD, TILE);
    ctx.drawImage(canvas, tx + TILE - 1, ty, 1, TILE, tx + TILE, ty, PAD, TILE);
    ctx.drawImage(canvas, tx, ty, 1, 1, x, y, PAD, PAD);
    ctx.drawImage(canvas, tx + TILE - 1, ty, 1, 1, tx + TILE, y, PAD, PAD);
    ctx.drawImage(canvas, tx, ty + TILE - 1, 1, 1, x, ty + TILE, PAD, PAD);
    ctx.drawImage(canvas, tx + TILE - 1, ty + TILE - 1, 1, 1, tx + TILE, ty + TILE, PAD, PAD);
    index[e.id] = { u0: tx / size, v0: ty / size, u1: (tx + TILE) / size, v1: (ty + TILE) / size };
    const data = ctx.getImageData(tx, ty, TILE, TILE).data;
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
  const ret: BuiltAtlas = { canvas, index, avgColors, hasAlpha };
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
