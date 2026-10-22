export const CHUNK_SIZE_BLOCKS = 16;
export const WORLD_MIN_Y = -80;
export const WORLD_MAX_Y = 384;
export const DEFAULT_SURFACE_Y = 64;
export const TOP_CLIP_STEP = 16;

export interface TopClipRange {
  minY: number;
  maxY: number;
}

export const UNCLIPPED_VIEW: Readonly<TopClipRange> = Object.freeze({ minY: WORLD_MIN_Y, maxY: WORLD_MAX_Y });

export function normalizeTopClipRange(range: TopClipRange, snapStep: number | null): TopClipRange {
  const normalize = (value: number, initial: number) => {
    const finite = Number.isFinite(value) ? value : initial;
    const snapped = snapStep === null ? finite : Math.round(finite / snapStep) * snapStep;
    return Math.max(WORLD_MIN_Y, Math.min(WORLD_MAX_Y, snapped));
  };
  const minY = normalize(range.minY, WORLD_MIN_Y);
  const maxY = normalize(range.maxY, WORLD_MAX_Y);
  return { minY: Math.min(minY, maxY), maxY: Math.max(minY, maxY) };
}
