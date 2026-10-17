import { clampFlyPitch, normalizeFlyYaw, type FlyView } from './controls';

export const VIEW_STORAGE_KEY = 'violet-map:view';
const DEFAULT_VIEW: FlyView = { x: 8, y: 120, z: 8, yaw: 0, pitch: 0 };

export type InitialView = FlyView & { hasAngles: boolean };

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function finiteParam(params: URLSearchParams, key: string, fallback: number): number {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function fixed(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '0';
}

function viewFromParams(params: URLSearchParams, defaults: FlyView = DEFAULT_VIEW): InitialView | null {
  const hasPosition = params.has('x') || params.has('y') || params.has('z');
  const hasAngles = params.has('yaw') || params.has('pitch');
  if (!hasPosition && !hasAngles) return null;
  return {
    x: finiteParam(params, 'x', defaults.x),
    y: finiteParam(params, 'y', defaults.y),
    z: finiteParam(params, 'z', defaults.z),
    yaw: normalizeFlyYaw(finiteParam(params, 'yaw', defaults.yaw)),
    pitch: clampFlyPitch(finiteParam(params, 'pitch', defaults.pitch)),
    hasAngles,
  };
}

function parseSavedView(raw: string | null): Partial<FlyView> | null {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Partial<FlyView>) : null;
  } catch {
    return null;
  }
}

function viewFromSaved(saved: Partial<FlyView> | null, defaults: FlyView = DEFAULT_VIEW): InitialView | null {
  if (!saved) return null;
  return {
    x: finiteNumber(saved.x, defaults.x),
    y: finiteNumber(saved.y, defaults.y),
    z: finiteNumber(saved.z, defaults.z),
    yaw: normalizeFlyYaw(finiteNumber(saved.yaw, defaults.yaw)),
    pitch: clampFlyPitch(finiteNumber(saved.pitch, defaults.pitch)),
    hasAngles: Number.isFinite(saved.yaw) || Number.isFinite(saved.pitch),
  };
}

/** Resolve URL camera overrides first, then saved state, then a safe world-height default. */
export function readInitialView(search: string, saved: string | null): InitialView {
  return (
    viewFromParams(new URLSearchParams(search)) ??
    viewFromSaved(parseSavedView(saved)) ?? { ...DEFAULT_VIEW, hasAngles: false }
  );
}

export function buildViewUrl(pathname: string, search: string, hash: string, view: FlyView): string {
  const params = new URLSearchParams(search);
  params.set('x', fixed(view.x, 2));
  params.set('y', fixed(view.y, 2));
  params.set('z', fixed(view.z, 2));
  params.set('yaw', fixed(normalizeFlyYaw(view.yaw), 4));
  params.set('pitch', fixed(clampFlyPitch(view.pitch), 4));
  params.delete('lookAtX');
  params.delete('lookAtY');
  params.delete('lookAtZ');
  return `${pathname}?${params.toString()}${hash}`;
}

export function lookAtTargetFromParams(
  params: URLSearchParams,
  fallback: Pick<FlyView, 'x' | 'y' | 'z'>,
): [number, number, number] | null {
  if (!params.has('lookAtX') && !params.has('lookAtY') && !params.has('lookAtZ')) return null;
  return [
    finiteParam(params, 'lookAtX', fallback.x),
    finiteParam(params, 'lookAtY', fallback.y),
    finiteParam(params, 'lookAtZ', fallback.z - 1),
  ];
}
