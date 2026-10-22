import { signal } from '@preact/signals';
import {
  WORLD_MIN_Y,
  WORLD_MAX_Y,
  TOP_CLIP_STEP,
  normalizeTopClipRange,
  type TopClipRange,
} from '../view/worldGeometry';
import type { ViewMode } from '../render/viewerEngine';
import { SCHEDULER_PRESETS, type SchedulerPreset } from '../scheduling/profiles';

export type DiagnosticDetail = 'off' | 'simple' | 'standard' | 'detailed';

export const SETTINGS_STORAGE_KEY = 'violet-map:settings';

export interface ViewerSettings {
  world: string;
  overlayMapId: string;
  overlaysEnabled: boolean;
  dimension: string;
  viewDistance: number;
  lodDistance: number;
  fastMoveMultiplier: number;
  inertiaEnabled: boolean;
  viewMode: ViewMode;
  topClipRange: TopClipRange;
  timeOfDay: number;
  debugLoggingEnabled: boolean;
  diagnosticDetail: DiagnosticDetail;
  schedulerPreset: SchedulerPreset;
  idbCacheEnabled: boolean;
}

type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function defaultTopClipRange(dimension: string): TopClipRange {
  if (dimension === 'minecraft:the_nether') return { minY: WORLD_MIN_Y, maxY: 96 };
  if (dimension === 'minecraft:overworld') return { minY: 16, maxY: WORLD_MAX_Y };
  return { minY: WORLD_MIN_Y, maxY: WORLD_MAX_Y };
}

/** Query overrides are session-local. Saved values retain their existing keys
 * and per-dimension clip ranges; unavailable or malformed storage is harmless. */
export function createSettingsStore(search: string, storage: SettingsStorage | null) {
  const params = new URLSearchParams(search);
  const read = () => {
    try {
      return record(JSON.parse(storage?.getItem(SETTINGS_STORAGE_KEY) ?? '{}'));
    } catch {
      return {};
    }
  };
  const saved = read();
  const string = (key: string, fallback: string) =>
    params.get(key) ?? (typeof saved[key] === 'string' ? saved[key] : fallback);
  const bool = (key: string, fallback: boolean) => {
    const query = params.get(key);
    return query !== null ? query === 'true' || query === '1' : typeof saved[key] === 'boolean' ? saved[key] : fallback;
  };
  const number = (key: string, fallback: number, min: number, max: number) => {
    const query = params.get(key);
    const candidate = query !== null && query.trim() !== '' ? Number(query) : saved[key];
    const value = typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : fallback;
    return Math.max(min, Math.min(max, value));
  };
  const choice = <T extends string>(key: string, fallback: T, choices: readonly T[]): T => {
    const value = string(key, fallback);
    return choices.includes(value as T) ? (value as T) : fallback;
  };
  const rangeFor = (dimension: string) => {
    const fallback = defaultTopClipRange(dimension);
    if (params.has('topClipMinY') || params.has('topClipMaxY')) {
      const coordinate = (key: string, fallback: number) => {
        const query = params.get(key);
        const value = query !== null && query.trim() !== '' ? Number(query) : NaN;
        return Number.isFinite(value) ? value : fallback;
      };
      return normalizeTopClipRange(
        {
          minY: coordinate('topClipMinY', fallback.minY),
          maxY: coordinate('topClipMaxY', fallback.maxY),
        },
        TOP_CLIP_STEP,
      );
    }
    const range = record(record(read().topClipRanges)[dimension]);
    return typeof range.minY === 'number' &&
      Number.isFinite(range.minY) &&
      typeof range.maxY === 'number' &&
      Number.isFinite(range.maxY)
      ? normalizeTopClipRange({ minY: range.minY, maxY: range.maxY }, TOP_CLIP_STEP)
      : fallback;
  };
  const dimension = string('dimension', 'minecraft:overworld');
  const state = signal<ViewerSettings>({
    world: string('world', ''),
    overlayMapId: string('overlayMapId', ''),
    overlaysEnabled: bool('overlaysEnabled', true),
    dimension,
    viewDistance: number('viewDistance', 8, 2, 32),
    lodDistance: number('lodDistance', 12, 0, 128),
    fastMoveMultiplier: number('fastMoveMultiplier', 4, 1, 16),
    inertiaEnabled: bool('inertiaEnabled', false),
    viewMode: choice('viewMode', 'perspective', ['perspective', 'topPerspective', 'topOrthographic']),
    topClipRange: rangeFor(dimension),
    timeOfDay: number('timeOfDay', 0, 0, 1),
    debugLoggingEnabled: bool('debugLoggingEnabled', false),
    diagnosticDetail: choice('diagnosticDetail', 'standard', ['off', 'simple', 'standard', 'detailed']),
    schedulerPreset: choice('schedulerPreset', 'medium', SCHEDULER_PRESETS),
    idbCacheEnabled: bool('idbCacheEnabled', true),
  });
  return {
    state,
    /** Apply related settings atomically; dimension changes restore that dimension's clip range. */
    update(patch: Partial<ViewerSettings>): void {
      const previous = state.peek();
      state.value = {
        ...previous,
        ...patch,
        ...(patch.dimension !== undefined && patch.dimension !== previous.dimension
          ? { topClipRange: rangeFor(patch.dimension) }
          : {}),
      };
    },
    /** Persist only fields that were not overridden by the startup URL. */
    persist(worldsLoaded: boolean): void {
      const value = state.value;
      const previous = read();
      const next = { ...previous };
      for (const [key, field] of Object.entries(value)) {
        if (key === 'topClipRange' || params.has(key)) continue;
        if (key === 'world' && !value.world && !worldsLoaded) continue;
        if (key === 'world' && !value.world) delete next.world;
        else next[key] = field;
      }
      if (!params.has('topClipMinY') && !params.has('topClipMaxY'))
        next.topClipRanges = { ...record(previous.topClipRanges), [value.dimension]: value.topClipRange };
      try {
        storage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* restricted storage */
      }
    },
  };
}
