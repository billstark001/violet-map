import { batch, computed, effect, signal } from '@preact/signals';
import type { WorldInfo } from '@violet-map/core/contracts';
import { fetchWorlds } from '../api';
import { setDebugLoggingEnabled } from '../logger';
import { getMeshCacheStats, setMeshCacheEnabled } from '../meshCache';
import { serviceCapabilities } from '../runtime';
import { EMPTY_CHUNK_SCHEDULER_STATS } from '../render/chunkScheduler';
import type { OverlayDiagnosticSnapshot } from '../render/overlayManager';
import type {
  CameraPositionRequest,
  ViewerDiagnosticSnapshot,
  ViewerOptions,
  ViewerStatsPayload,
} from '../render/viewerEngine';
import { createSettingsStore } from './settings';
import { browserStorage, readStored } from '../browserStorage';

export const settings = createSettingsStore(
  typeof location === 'undefined' ? '' : location.search,
  browserStorage('localStorage'),
);
export const worlds = signal<WorldInfo[]>([]);
export const worldsLoading = signal(false);
export const worldsLoaded = signal(false);
export const worldsError = signal<string | null>(null);
export const viewerReady = signal(false);
export const viewerError = signal<string | null>(null);
export const stats = signal<ViewerStatsPayload>({
  ...EMPTY_CHUNK_SCHEDULER_STATS,
  pos: [0, 0, 0],
  yaw: 0,
  pitch: 0,
  viewMode: settings.state.peek().viewMode,
});
export const overlayStatus = signal<OverlayDiagnosticSnapshot | null>(null);
export const cameraTarget = signal<CameraPositionRequest | undefined>(undefined);
export const diagnosticProvider = signal<(() => ViewerDiagnosticSnapshot | null) | null>(null);
export const cacheStats = signal({ entries: 0, bytes: 0 });
const PANEL_STORAGE_KEY = 'violet-map:panel-collapsed';
const DIAGNOSTIC_PANEL_STORAGE_KEY = 'violet-map:diagnostic-panel-collapsed';
export const panelCollapsed = signal(readStored(browserStorage('localStorage'), PANEL_STORAGE_KEY) === 'true');
export const diagnosticCollapsed = signal(
  readStored(browserStorage('localStorage'), DIAGNOSTIC_PANEL_STORAGE_KEY) === 'true',
);
export const panelTab = signal<'view' | 'settings'>('view');
export const dimensions = computed(
  () => worlds.value.find((world) => world.id === settings.state.value.world)?.dimensions ?? [],
);
export const overlayMaps = computed(() =>
  serviceCapabilities().contentReads
    ? (worlds.value.find((world) => world.id === settings.state.value.world)?.mapIds ?? [])
    : [],
);
export const activeOverlayMap = computed(() =>
  overlayMaps.value.includes(settings.state.value.overlayMapId)
    ? settings.state.value.overlayMapId
    : overlayMaps.value[0],
);
const viewerCallbacks: Pick<ViewerOptions, 'onStats' | 'onOverlayStatus' | 'onDiagnosticSnapshotProvider'> = {
  onStats: (next) => {
    stats.value = next;
  },
  onOverlayStatus: (next) => {
    overlayStatus.value = next;
  },
  onDiagnosticSnapshotProvider: (provider) => {
    diagnosticProvider.value = provider;
  },
};

export const viewerOptions = computed<ViewerOptions>(() => ({
  ...settings.state.value,
  ...viewerCallbacks,
  overlayMapId: activeOverlayMap.value,
  cameraTarget: cameraTarget.value,
}));

let worldsRequest: AbortController | null = null;

/** Refresh a shared world list; aborts superseded requests and keeps errors visible for retry. */
export async function loadWorlds(): Promise<void> {
  worldsRequest?.abort();
  const request = new AbortController();
  worldsRequest = request;
  batch(() => {
    worldsLoading.value = true;
    worldsError.value = null;
  });
  try {
    const next = await fetchWorlds(request.signal);
    if (request.signal.aborted) return;
    batch(() => {
      worlds.value = next;
      const current = settings.state.peek();
      const selected = next.find((world) => world.id === current.world) ?? next[0];
      settings.update({
        world: selected?.id ?? '',
        dimension: selected?.dimensions.includes(current.dimension)
          ? current.dimension
          : (selected?.dimensions[0] ?? current.dimension),
      });
      worldsLoaded.value = true;
      worldsLoading.value = false;
    });
  } catch (error) {
    if (!request.signal.aborted)
      batch(() => {
        worldsLoading.value = false;
        worldsError.value = error instanceof Error ? error.message : String(error);
      });
  }
}

export async function refreshCacheStats(): Promise<void> {
  try {
    cacheStats.value = await getMeshCacheStats();
  } catch (error) {
    console.warn('mesh cache stats', error);
  }
}

/** Bind persistence and shared side effects once, independently of component renders. */
export function startViewerState(): () => void {
  const persistFlag = (key: string, value: boolean) => {
    try {
      browserStorage('localStorage')?.setItem(key, String(value));
    } catch {
      /* restricted storage */
    }
  };
  const cacheWanted = computed(
    () =>
      settings.state.value.idbCacheEnabled &&
      ((!panelCollapsed.value && panelTab.value === 'settings') ||
        (settings.state.value.diagnosticDetail === 'detailed' && !diagnosticCollapsed.value)),
  );
  const debugEnabled = computed(() => settings.state.value.debugLoggingEnabled);
  const cacheEnabled = computed(() => settings.state.value.idbCacheEnabled);
  const cleanups = [
    effect(() => settings.persist(worldsLoaded.value)),
    effect(() => setDebugLoggingEnabled(debugEnabled.value)),
    effect(() => {
      const enabled = cacheEnabled.value;
      setMeshCacheEnabled(enabled);
      if (!enabled) cacheStats.value = { entries: 0, bytes: 0 };
    }),
    effect(() => persistFlag(PANEL_STORAGE_KEY, panelCollapsed.value)),
    effect(() => persistFlag(DIAGNOSTIC_PANEL_STORAGE_KEY, diagnosticCollapsed.value)),
    effect(() => {
      if (!cacheWanted.value) return;
      let active = true;
      const refresh = async () => {
        try {
          const next = await getMeshCacheStats();
          if (active) cacheStats.value = next;
        } catch (error) {
          console.warn('mesh cache stats', error);
        }
      };
      void refresh();
      const timer = setInterval(() => {
        void refresh();
      }, 5000);
      return () => {
        active = false;
        clearInterval(timer);
      };
    }),
  ];
  void loadWorlds();
  return () => {
    worldsRequest?.abort();
    for (const cleanup of cleanups) cleanup();
  };
}
