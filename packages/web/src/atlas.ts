import type { AssetBundle, AtlasIndex, BlockInfoMap, BlockModelJson } from '@mcr/core';
import { textureUrl } from './api';

export interface BuiltAtlas {
  canvas: HTMLCanvasElement;
  index: AtlasIndex;
  avgColors: Record<string, [number, number, number]>;
}

export function collectTextureIds(bundle: AssetBundle, blockInfo: BlockInfoMap): string[] {
  const ids = new Set<string>();
  const add = (v: string) => {
    if (!v.startsWith('#')) ids.add(v.includes(':') ? v : `minecraft:${v}`);
  };
  for (const model of Object.values(bundle.models) as BlockModelJson[]) {
    if (model.textures) for (const v of Object.values(model.textures)) add(v);
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
  const results = await Promise.allSettled(ids.map((id) => loadImage(textureUrl(id))));
  const entries: { id: string; img: HTMLImageElement | null }[] = [{ id: '__missing__', img: null }];
  results.forEach((r, i) => entries.push({ id: ids[i], img: r.status === 'fulfilled' ? r.value : null }));

  const cols = Math.ceil(Math.sqrt(entries.length));
  let size = 1;
  while (size < cols * TILE) size *= 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;

  const index: AtlasIndex = {};
  const avgColors: Record<string, [number, number, number]> = {};
  const inset = 0.25 / size; // 防渗色的四分之一像素内缩

  entries.forEach((e, i) => {
    const x = (i % cols) * TILE;
    const y = Math.floor(i / cols) * TILE;
    if (e.img) {
      const w = e.img.width;
      ctx.drawImage(e.img, 0, 0, w, w, x, y, TILE, TILE);
    } else {
      ctx.fillStyle = '#f800f8'; ctx.fillRect(x, y, TILE, TILE);
      ctx.fillStyle = '#000000'; ctx.fillRect(x, y, 8, 8); ctx.fillRect(x + 8, y + 8, 8, 8);
    }
    index[e.id] = { u0: x / size + inset, v0: y / size + inset, u1: (x + TILE) / size - inset, v1: (y + TILE) / size - inset };
    const data = ctx.getImageData(x, y, TILE, TILE).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let p = 0; p < data.length; p += 4) {
      if (data[p + 3] < 32) continue;
      r += data[p]; g += data[p + 1]; b += data[p + 2]; n++;
    }
    avgColors[e.id] = n ? [r / n / 255, g / n / 255, b / n / 255] : [1, 0, 1];
  });
  return { canvas, index, avgColors };
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