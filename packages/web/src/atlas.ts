import { type AtlasIndex, type TextureAlphaMap } from '@violet-map/core/assets';
import { fetchTexture, fetchTextureAtlas } from './api';
import { loadBrowserImage } from './browserImage';
import { resourceDownloader } from './resources/download';

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

const MAX_ANIMATION_TABLE_ENTRIES = 65535;
const MAX_ANIMATION_FRAME_TICKS = 255;

/** Encode animation sequences within the 16-bit start and length fields used by shaders. */
export function textureAnimationData(index: AtlasIndex): TextureAnimationData {
  const ids: Record<string, number> = {};
  const sequences: { id: string; frames: { u0: number; v0: number; u1: number; v1: number }[] }[] = [];
  let remainingFrames = MAX_ANIMATION_TABLE_ENTRIES;
  for (const [id, rect] of Object.entries(index).sort(([a], [b]) => a.localeCompare(b))) {
    const animation = rect.animation;
    if (!animation || animation.frames.length < 2) continue;
    const expanded: { u0: number; v0: number; u1: number; v1: number }[] = [];
    for (let i = 0; i < animation.frames.length && expanded.length < remainingFrames; i++) {
      const time = Math.max(1, Math.min(MAX_ANIMATION_FRAME_TICKS, Math.floor(animation.times[i] ?? 1)));
      for (let tick = 0; tick < time && expanded.length < remainingFrames; tick++) expanded.push(animation.frames[i]);
    }
    if (expanded.length > 1 && sequences.length < MAX_ANIMATION_TABLE_ENTRIES) {
      sequences.push({ id, frames: expanded });
      remainingFrames -= expanded.length;
    }
    if (remainingFrames < 2) break;
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
      encode16(frames, p0, frame.u0);
      encode16(frames, p0 + 2, frame.v0);
      encode16(frames, p1, frame.u1);
      encode16(frames, p1 + 2, frame.v1);
      start++;
    }
  });
  return { ids, info, infoSize: [infoWidth, infoHeight], frames, frameSize: [frameWidth, frameHeight] };
}

export async function resourceImage(
  reference: import('@violet-map/core/resources').ResourceRef,
  signal?: AbortSignal,
): Promise<HTMLImageElement> {
  const bytes = await resourceDownloader.download(reference, signal);
  const url = URL.createObjectURL(new Blob([bytes], { type: reference.artifact.mediaType }));
  try {
    return await loadBrowserImage(url, signal);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function loadTextureImage(id: string, signal?: AbortSignal): Promise<HTMLImageElement | null> {
  const reference = await fetchTexture(id, signal);
  return reference ? resourceImage(reference, signal) : null;
}

export async function buildAtlas(ids: string[], signal?: AbortSignal): Promise<BuiltAtlas> {
  const manifest = await fetchTextureAtlas(ids, signal);
  const image = await resourceImage(manifest.image, signal);
  const canvas = document.createElement('canvas');
  canvas.width = manifest.width;
  canvas.height = manifest.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('atlas canvas is unavailable');
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0);
  return {
    cacheKey: manifest.cacheKey,
    canvas,
    index: manifest.index,
    avgColors: manifest.avgColors,
    hasAlpha: manifest.hasAlpha,
    animations: textureAnimationData(manifest.index),
  };
}

/** 载入原版 colormap（256×256 RGBA）。 */
export async function loadColormap(id: string, signal?: AbortSignal): Promise<Uint8Array | null> {
  const image = await loadTextureImage(id, signal);
  if (!image) return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('colormap canvas is unavailable');
  context.drawImage(image, 0, 0, 256, 256);
  return new Uint8Array(context.getImageData(0, 0, 256, 256).data.buffer);
}
