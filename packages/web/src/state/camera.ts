import type { ViewerStatsPayload } from '../render/viewerEngine';
import { clampFlyPitch, normalizeFlyYaw } from '../render/controls';
import { formatScalar } from '../format';

export type CameraDraft = Record<'x' | 'y' | 'z' | 'yaw' | 'pitch', string>;

export function cameraDraft(stats: ViewerStatsPayload): CameraDraft {
  return {
    x: formatScalar(stats.pos[0]),
    y: formatScalar(stats.pos[1]),
    z: formatScalar(stats.pos[2]),
    yaw: formatScalar((normalizeFlyYaw(stats.yaw) * 180) / Math.PI),
    pitch: formatScalar((clampFlyPitch(stats.pitch) * 180) / Math.PI),
  };
}

/** Reject empty/nonfinite coordinates and normalize degree inputs into camera radians. */
export function parseCameraDraft(
  draft: CameraDraft,
): { x: number; y: number; z: number; yaw: number; pitch: number } | null {
  if (Object.values(draft).some((value) => value.trim() === '' || !Number.isFinite(Number(value)))) return null;
  return {
    x: Number(draft.x),
    y: Number(draft.y),
    z: Number(draft.z),
    yaw: normalizeFlyYaw((Number(draft.yaw) * Math.PI) / 180),
    pitch: clampFlyPitch((Number(draft.pitch) * Math.PI) / 180),
  };
}
