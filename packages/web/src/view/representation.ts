import type { TopClipRange } from './worldGeometry';
import { WORLD_MAX_Y } from './worldGeometry';

/** Surface-only representations cannot expose a slice below their baked/generated surface. */
export function surfaceRepresentationAllowed(mode: 'perspective' | 'top', clip: TopClipRange): boolean {
  return mode === 'perspective' || clip.maxY >= WORLD_MAX_Y;
}
