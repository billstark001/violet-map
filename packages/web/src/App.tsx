import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Box, Button, Card, Flex, Select, Slider, Switch, Tabs, Text, TextField, Theme } from '@radix-ui/themes';
import { useTranslation } from 'react-i18next';
import { fetchWorlds, uploadDiagnosticSnapshot } from './api';
import { Compass } from './Compass';
import { languageOptions } from './i18n';
import { clearDebugLog, setDebugLoggingEnabled } from './logger';
import { clearMeshCache, getMeshCacheStats } from './meshCache';
import {
  Viewer,
  type CameraPositionRequest,
  type ViewerDiagnosticSnapshot,
  type ViewerStatsPayload,
  type ViewMode,
} from './render/Viewer';
import { EMPTY_CHUNK_SCHEDULER_STATS, type SchedulerPreset } from './render/chunkScheduler';
import type { TopClipRange } from './render/chunkManager';

interface WorldInfo { id: string; dimensions: string[] }
type Axis = 'x' | 'y' | 'z';
type AngleAxis = 'yaw' | 'pitch';
type DiagnosticDetail = 'off' | 'simple' | 'standard' | 'detailed';
type ViewerStats = ViewerStatsPayload;

const SETTINGS_STORAGE_KEY = 'violet-map:settings';
const PANEL_STORAGE_KEY = 'violet-map:panel-collapsed';
const DIAGNOSTIC_PANEL_STORAGE_KEY = 'violet-map:diagnostic-panel-collapsed';
const DIAGNOSTIC_TOKEN_STORAGE_KEY = 'violet-map:diagnostic-server-token';
const TOP_CLIP_MIN_Y = -80;
const TOP_CLIP_MAX_Y = 384;
const TOP_CLIP_STEP = 16;

interface ViewerSettings {
  world?: string;
  dimension?: string;
  viewDistance?: number;
  lodDistance?: number;
  fastMoveMultiplier?: number;
  inertiaEnabled?: boolean;
  viewMode?: ViewMode;
  topClipRanges?: Record<string, TopClipRange>;
  timeOfDay?: number;
  debugLoggingEnabled?: boolean;
  diagnosticDetail?: DiagnosticDetail;
  schedulerPreset?: SchedulerPreset;
}

const params = new URLSearchParams(location.search);

function readSavedSettings(): ViewerSettings {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}') as ViewerSettings;
  } catch {
    return {};
  }
}

function numberSetting(key: keyof ViewerSettings, fallback: number): number {
  if (params.has(key)) {
    const query = Number(params.get(key));
    if (Number.isFinite(query)) return query;
  }
  try {
    const saved = readSavedSettings();
    const value = saved[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function stringSetting(key: keyof ViewerSettings, fallback: string): string {
  const query = params.get(key);
  if (query !== null) return query;
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}') as ViewerSettings;
    const value = saved[key];
    return typeof value === 'string' ? value : fallback;
  } catch {
    return fallback;
  }
}

function diagnosticDetailSetting(): DiagnosticDetail {
  const value = stringSetting('diagnosticDetail', 'standard');
  return value === 'off' || value === 'simple' || value === 'standard' || value === 'detailed'
    ? value
    : 'standard';
}

function schedulerPresetSetting(): SchedulerPreset {
  const value = stringSetting('schedulerPreset', 'medium');
  return value === 'potato' || value === 'low' || value === 'medium' || value === 'high' || value === 'extreme'
    ? value
    : 'medium';
}

function booleanSetting(key: keyof ViewerSettings, fallback: boolean): boolean {
  const query = params.get(key);
  if (query !== null) return query === 'true' || query === '1';
  try {
    const saved = readSavedSettings();
    const value = saved[key];
    return typeof value === 'boolean' ? value : fallback;
  } catch {
    return fallback;
  }
}

function viewModeSetting(): ViewMode {
  const value = stringSetting('viewMode', 'perspective');
  return value === 'topPerspective' || value === 'topOrthographic' ? value : 'perspective';
}

function snapTopClipY(value: number): number {
  if (!Number.isFinite(value)) return TOP_CLIP_MIN_Y;
  const snapped = Math.round(value / TOP_CLIP_STEP) * TOP_CLIP_STEP;
  return Math.max(TOP_CLIP_MIN_Y, Math.min(TOP_CLIP_MAX_Y, snapped));
}

function normalizeTopClipRange(range: TopClipRange): TopClipRange {
  const minY = snapTopClipY(range.minY);
  const maxY = snapTopClipY(range.maxY);
  return {
    minY: Math.min(minY, maxY),
    maxY: Math.max(minY, maxY),
  };
}

function defaultTopClipRange(dimension: string): TopClipRange {
  if (dimension === 'minecraft:the_nether') return { minY: TOP_CLIP_MIN_Y, maxY: 96 };
  if (dimension === 'minecraft:overworld') return { minY: 16, maxY: TOP_CLIP_MAX_Y };
  return { minY: TOP_CLIP_MIN_Y, maxY: TOP_CLIP_MAX_Y };
}

function topClipRangeSetting(dimension: string): TopClipRange {
  const fallback = defaultTopClipRange(dimension);
  if (params.has('topClipMinY') || params.has('topClipMaxY')) {
    const minParam = params.get('topClipMinY');
    const maxParam = params.get('topClipMaxY');
    const minQuery = minParam === null ? NaN : Number(minParam);
    const maxQuery = maxParam === null ? NaN : Number(maxParam);
    return normalizeTopClipRange({
      minY: Number.isFinite(minQuery) ? minQuery : fallback.minY,
      maxY: Number.isFinite(maxQuery) ? maxQuery : fallback.maxY,
    });
  }
  try {
    const saved = readSavedSettings().topClipRanges?.[dimension];
    if (saved && Number.isFinite(saved.minY) && Number.isFinite(saved.maxY)) return normalizeTopClipRange(saved);
  } catch {
    // Ignore malformed persisted settings.
  }
  return fallback;
}

function initialViewerStats(viewMode: ViewMode): ViewerStats {
  return { ...EMPTY_CHUNK_SCHEDULER_STATS, pos: [0, 0, 0], yaw: 0, pitch: 0, viewMode };
}

function coordText(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const rounded = Math.round(v * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function normalizeYawDegrees(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function clampPitchDegrees(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const max = 90 - 0.01 * 180 / Math.PI;
  return Math.max(-max, Math.min(max, value));
}

function degreesText(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function angleDraftFromStats(stats: ViewerStats): Record<AngleAxis, string> {
  return {
    yaw: degreesText(normalizeYawDegrees(stats.yaw * 180 / Math.PI)),
    pitch: degreesText(clampPitchDegrees(stats.pitch * 180 / Math.PI)),
  };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 ms';
  return `${ms >= 10 ? ms.toFixed(0) : ms.toFixed(1)} ms`;
}

function formatTime(time: number): string {
  return new Date(time).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function App() {
  const { t, i18n } = useTranslation();
  const [worlds, setWorlds] = useState<WorldInfo[]>([]);
  const [world, setWorld] = useState(() => stringSetting('world', ''));
  const [dimension, setDimension] = useState(() => stringSetting('dimension', 'minecraft:overworld'));
  const [viewDistance, setViewDistance] = useState(() => numberSetting('viewDistance', 8));
  const [lodDistance, setLodDistance] = useState(() => numberSetting('lodDistance', 12));
  const [fastMoveMultiplier, setFastMoveMultiplier] = useState(() => numberSetting('fastMoveMultiplier', 4));
  const [inertiaEnabled, setInertiaEnabled] = useState(() => booleanSetting('inertiaEnabled', false));
  const [viewMode, setViewMode] = useState<ViewMode>(() => viewModeSetting());
  const [topClipRange, setTopClipRange] = useState<TopClipRange>(() => topClipRangeSetting(stringSetting('dimension', 'minecraft:overworld')));
  const [timeOfDay, setTimeOfDay] = useState(() => numberSetting('timeOfDay', 0));
  const [debugLoggingEnabled, setDebugLoggingEnabledState] = useState(() => booleanSetting('debugLoggingEnabled', false));
  const [diagnosticDetail, setDiagnosticDetail] = useState<DiagnosticDetail>(() => diagnosticDetailSetting());
  const [schedulerPreset, setSchedulerPreset] = useState<SchedulerPreset>(() => schedulerPresetSetting());
  const [panelCollapsed, setPanelCollapsed] = useState(() => localStorage.getItem(PANEL_STORAGE_KEY) === 'true');
  const [diagnosticCollapsed, setDiagnosticCollapsed] = useState(() => localStorage.getItem(DIAGNOSTIC_PANEL_STORAGE_KEY) === 'true');
  const [diagnosticServerToken, setDiagnosticServerToken] = useState(() => {
    try {
      return sessionStorage.getItem(DIAGNOSTIC_TOKEN_STORAGE_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [diagnosticUploadStatus, setDiagnosticUploadStatus] = useState<'idle' | 'uploading' | 'uploaded' | 'error'>('idle');
  const [diagnosticUploadMessage, setDiagnosticUploadMessage] = useState('');
  const [diagnosticSnapshotAvailable, setDiagnosticSnapshotAvailable] = useState(false);
  const [stats, setStats] = useState<ViewerStats>(() => initialViewerStats(viewMode));
  const latestStatsRef = useRef<ViewerStats>(initialViewerStats(viewMode));
  const diagnosticSnapshotProviderRef = useRef<(() => ViewerDiagnosticSnapshot | null) | null>(null);
  const [panelTab, setPanelTab] = useState('view');
  const [cacheStats, setCacheStats] = useState({ entries: 0, bytes: 0 });
  const [coordDirty, setCoordDirty] = useState(false);
  const [coordDraft, setCoordDraft] = useState<Record<Axis, string>>({ x: '0', y: '80', z: '0' });
  const [angleDraft, setAngleDraft] = useState<Record<AngleAxis, string>>({ yaw: '0', pitch: '0' });
  const [cameraTarget, setCameraTarget] = useState<CameraPositionRequest>();
  const [worldsLoaded, setWorldsLoaded] = useState(false);

  useEffect(() => {
    fetchWorlds().then((ws) => {
      setWorlds(ws);
      if (ws.length) {
        const selectedWorld = ws.find((w) => w.id === world)?.id ?? ws[0].id;
        const dims = ws.find((w) => w.id === selectedWorld)?.dimensions ?? [];
        setWorld(selectedWorld);
        setDimension((d) => {
          const nextDimension = dims.includes(d) ? d : (dims[0] ?? 'minecraft:overworld');
          if (nextDimension !== d) setTopClipRange(topClipRangeSetting(nextDimension));
          return nextDimension;
        });
      }
      setWorldsLoaded(true);
    }).catch(console.error);
  }, []);

  useEffect(() => {
    try {
      const previous = readSavedSettings();
      const next: ViewerSettings = { ...previous };
      if (!params.has('world') && (world || worldsLoaded)) {
        if (world) next.world = world;
        else delete next.world;
      }
      if (!params.has('dimension')) next.dimension = dimension;
      if (!params.has('viewDistance')) next.viewDistance = viewDistance;
      if (!params.has('lodDistance')) next.lodDistance = lodDistance;
      if (!params.has('fastMoveMultiplier')) next.fastMoveMultiplier = fastMoveMultiplier;
      if (!params.has('inertiaEnabled')) next.inertiaEnabled = inertiaEnabled;
      if (!params.has('viewMode')) next.viewMode = viewMode;
      if (!params.has('topClipMinY') && !params.has('topClipMaxY')) {
        next.topClipRanges = { ...(previous.topClipRanges ?? {}), [dimension]: topClipRange };
      }
      if (!params.has('timeOfDay')) next.timeOfDay = timeOfDay;
      if (!params.has('debugLoggingEnabled')) next.debugLoggingEnabled = debugLoggingEnabled;
      if (!params.has('diagnosticDetail')) next.diagnosticDetail = diagnosticDetail;
      if (!params.has('schedulerPreset')) next.schedulerPreset = schedulerPreset;
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage may be unavailable in restricted contexts.
    }
  }, [
    world,
    dimension,
    viewDistance,
    lodDistance,
    fastMoveMultiplier,
    inertiaEnabled,
    viewMode,
    topClipRange,
    timeOfDay,
    debugLoggingEnabled,
    diagnosticDetail,
    schedulerPreset,
    worldsLoaded,
  ]);

  useEffect(() => {
    setDebugLoggingEnabled(debugLoggingEnabled);
  }, [debugLoggingEnabled]);

  useEffect(() => {
    try {
      localStorage.setItem(PANEL_STORAGE_KEY, String(panelCollapsed));
    } catch {
      // Ignore storage failures.
    }
  }, [panelCollapsed]);

  useEffect(() => {
    try {
      localStorage.setItem(DIAGNOSTIC_PANEL_STORAGE_KEY, String(diagnosticCollapsed));
    } catch {
      // Ignore storage failures.
    }
  }, [diagnosticCollapsed]);

  useEffect(() => {
    const cacheStatsVisible = (!panelCollapsed && panelTab === 'settings') || (diagnosticDetail === 'detailed' && !diagnosticCollapsed);
    if (!cacheStatsVisible) return;
    let cancelled = false;
    const refresh = () => {
      getMeshCacheStats()
        .then((next) => { if (!cancelled) setCacheStats(next); })
        .catch(console.error);
    };
    refresh();
    const id = window.setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [panelCollapsed, panelTab, diagnosticDetail, diagnosticCollapsed]);

  const dims = worlds.find((w) => w.id === world)?.dimensions ?? [];
  const draftValues = [Number(coordDraft.x), Number(coordDraft.y), Number(coordDraft.z)] as const;
  const angleDraftValues = [Number(angleDraft.yaw), Number(angleDraft.pitch)] as const;
  const draftValid = draftValues.every(Number.isFinite) && angleDraftValues.every(Number.isFinite);
  const showStandardDiagnostics = diagnosticDetail === 'standard' || diagnosticDetail === 'detailed';
  const showDetailedDiagnostics = diagnosticDetail === 'detailed';
  const handleStats = (next: typeof stats) => {
    latestStatsRef.current = next;
    setStats(next);
    if (!coordDirty) {
      const draft = { x: coordText(next.pos[0]), y: coordText(next.pos[1]), z: coordText(next.pos[2]) };
      setCoordDraft((prev) => (
        prev.x === draft.x && prev.y === draft.y && prev.z === draft.z ? prev : draft
      ));
      const angle = angleDraftFromStats(next);
      setAngleDraft((prev) => (
        prev.yaw === angle.yaw && prev.pitch === angle.pitch ? prev : angle
      ));
    }
  };
  const setAxis = (axis: Axis, value: string) => {
    setCoordDirty(true);
    setCoordDraft((prev) => ({ ...prev, [axis]: value }));
  };
  const setAngleAxis = (axis: AngleAxis, value: string) => {
    setCoordDirty(true);
    setAngleDraft((prev) => ({ ...prev, [axis]: value }));
  };
  const useCurrentPosition = () => {
    const current = latestStatsRef.current;
    setCoordDraft({ x: coordText(current.pos[0]), y: coordText(current.pos[1]), z: coordText(current.pos[2]) });
    setAngleDraft(angleDraftFromStats(current));
    setCoordDirty(false);
  };
  const applyPosition = () => {
    if (!draftValid) return;
    const yawDeg = normalizeYawDegrees(angleDraftValues[0]);
    const pitchDeg = clampPitchDegrees(angleDraftValues[1]);
    setCoordDirty(false);
    setAngleDraft({ yaw: degreesText(yawDeg), pitch: degreesText(pitchDeg) });
    setCameraTarget({
      x: draftValues[0],
      y: draftValues[1],
      z: draftValues[2],
      yaw: yawDeg * Math.PI / 180,
      pitch: pitchDeg * Math.PI / 180,
      seq: Date.now(),
    });
  };
  const changeDimension = (value: string) => {
    setDimension(value);
    setTopClipRange(topClipRangeSetting(value));
  };
  const setTopClipMinY = (value: number) => {
    setTopClipRange((prev) => normalizeTopClipRange({ minY: Math.min(value, prev.maxY), maxY: prev.maxY }));
  };
  const setTopClipMaxY = (value: number) => {
    setTopClipRange((prev) => normalizeTopClipRange({ minY: prev.minY, maxY: Math.max(value, prev.minY) }));
  };
  const resetTopClipRange = () => {
    setTopClipRange(defaultTopClipRange(dimension));
  };
  const changeLanguage = (lng: string) => {
    void i18n.changeLanguage(lng);
    try {
      localStorage.setItem('violet-map:language', lng);
    } catch {
      // Ignore storage failures.
    }
  };
  const refreshCacheStats = () => {
    getMeshCacheStats().then(setCacheStats).catch(console.error);
  };
  const handleClearCache = () => {
    clearMeshCache()
      .then(refreshCacheStats)
      .catch(console.error);
  };
  const setDiagnosticSnapshotProvider = useCallback((provider: (() => ViewerDiagnosticSnapshot | null) | null) => {
    diagnosticSnapshotProviderRef.current = provider;
    setDiagnosticSnapshotAvailable(provider !== null);
  }, []);
  const setDiagnosticToken = (value: string) => {
    setDiagnosticServerToken(value);
    try {
      if (value) sessionStorage.setItem(DIAGNOSTIC_TOKEN_STORAGE_KEY, value);
      else sessionStorage.removeItem(DIAGNOSTIC_TOKEN_STORAGE_KEY);
    } catch {
      // Session storage may be unavailable in restricted contexts.
    }
  };
  const captureDiagnosticSnapshot = (): ViewerDiagnosticSnapshot | null => diagnosticSnapshotProviderRef.current?.() ?? null;
  const handleDownloadDiagnosticSnapshot = () => {
    const snapshot = captureDiagnosticSnapshot();
    if (!snapshot) return;
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `violet-map-diagnosis-${snapshot.capturedAt.replace(/[:.]/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const handleUploadDiagnosticSnapshot = () => {
    const snapshot = captureDiagnosticSnapshot();
    if (!snapshot || !diagnosticServerToken.trim()) return;
    setDiagnosticUploadStatus('uploading');
    setDiagnosticUploadMessage('');
    void uploadDiagnosticSnapshot(snapshot, diagnosticServerToken.trim())
      .then(({ id }) => {
        setDiagnosticUploadStatus('uploaded');
        setDiagnosticUploadMessage(id);
      })
      .catch((error) => {
        setDiagnosticUploadStatus('error');
        setDiagnosticUploadMessage(error instanceof Error ? error.message : String(error));
      });
  };

  return (
    <Theme appearance="dark" accentColor="grass" style={{ height: '100%' }}>
      <Box style={{ position: 'relative', height: '100%' }}>
        {world && (
          <Viewer
            world={world} dimension={dimension}
            viewDistance={viewDistance} lodDistance={lodDistance}
            schedulerPreset={schedulerPreset}
            fastMoveMultiplier={fastMoveMultiplier} inertiaEnabled={inertiaEnabled} viewMode={viewMode}
            topClipRange={topClipRange}
            timeOfDay={timeOfDay} cameraTarget={cameraTarget} onStats={handleStats}
            onDiagnosticSnapshotProvider={setDiagnosticSnapshotProvider}
          />
        )}
        {viewMode === 'perspective' && (
          <div style={{
            position: 'absolute', left: '50%', top: '50%', width: 12, height: 12,
            transform: 'translate(-50%,-50%)', pointerEvents: 'none',
            background: 'radial-gradient(circle, rgba(255,255,255,.8) 0 1.5px, transparent 2px)',
          }} />
        )}
        <Compass yaw={stats.yaw} pitch={stats.pitch} viewMode={viewMode} />
        <Card style={{
          position: 'absolute',
          top: 12,
          left: 12,
          width: panelCollapsed ? 48 : 320,
          opacity: 0.96,
          backgroundColor: 'rgba(5, 9, 18, 0.92)',
          borderColor: 'rgba(148, 163, 184, 0.22)',
          transition: 'width 140ms ease',
        }}>
          <Flex direction="column" gap="3">
            <Flex justify="between" align="center">
              {!panelCollapsed && <Text size="2" weight="bold">Violet Map</Text>}
              <Button
                size="1"
                variant="ghost"
                aria-label={panelCollapsed ? t('expandPanel') : t('collapsePanel')}
                onClick={() => setPanelCollapsed((v) => !v)}
                style={{ width: 28, height: 28, padding: 0, marginLeft: panelCollapsed ? -4 : 0 }}
              >
                {panelCollapsed ? '>' : '<'}
              </Button>
            </Flex>
            {!panelCollapsed && (
              <Tabs.Root value={panelTab} onValueChange={setPanelTab}>
                <Tabs.List size="1">
                  <Tabs.Trigger value="view">{t('tabView')}</Tabs.Trigger>
                  <Tabs.Trigger value="settings">{t('tabSettings')}</Tabs.Trigger>
                </Tabs.List>
                <Box pt="3">
                  <Tabs.Content value="view">
                    <Flex direction="column" gap="3">
                      <Flex gap="2" align="center">
                        <Text size="1" style={{ width: 64 }}>{t('world')}</Text>
                        <Select.Root value={world} onValueChange={setWorld}>
                          <Select.Trigger style={{ flex: 1 }} placeholder={t('selectWorld')} />
                          <Select.Content>
                            {worlds.map((w) => <Select.Item key={w.id} value={w.id}>{w.id}</Select.Item>)}
                          </Select.Content>
                        </Select.Root>
                      </Flex>
                      <Flex gap="2" align="center">
                        <Text size="1" style={{ width: 64 }}>{t('dimension')}</Text>
                        <Select.Root value={dimension} onValueChange={changeDimension}>
                          <Select.Trigger style={{ flex: 1 }} />
                          <Select.Content>
                            {dims.map((d) => <Select.Item key={d} value={d}>{d.replace('minecraft:', '')}</Select.Item>)}
                          </Select.Content>
                        </Select.Root>
                      </Flex>
                      <Box>
                        <Text size="1">{t('fullRadius', { value: viewDistance })}</Text>
                        <Slider value={[viewDistance]} min={2} max={32} onValueChange={([v]) => setViewDistance(v)} />
                        <Text mt="2" size="1">{t('lodRadius', { value: lodDistance })}</Text>
                        <Slider mt="1" value={[lodDistance]} min={0} max={128} onValueChange={([v]) => setLodDistance(v)} />
                      </Box>
                      <Box>
                        <Text size="1">{t('fastMove', { value: fastMoveMultiplier.toFixed(1) })}</Text>
                        <Slider value={[fastMoveMultiplier]} min={1} max={16} step={0.5} onValueChange={([v]) => setFastMoveMultiplier(v)} />
                      </Box>
                      <Flex gap="2" align="center" justify="between">
                        <Text as="label" size="1" htmlFor="inertia-toggle">{t('inertia')}</Text>
                        <Switch id="inertia-toggle" checked={inertiaEnabled} onCheckedChange={setInertiaEnabled} />
                      </Flex>
                      <Flex gap="2" align="center">
                        <Text size="1" style={{ width: 64 }}>{t('viewMode')}</Text>
                        <Select.Root value={viewMode} onValueChange={(value) => setViewMode(value as ViewMode)}>
                          <Select.Trigger style={{ flex: 1 }} />
                          <Select.Content>
                            <Select.Item value="perspective">{t('viewModePerspective')}</Select.Item>
                            <Select.Item value="topPerspective">{t('viewModeTopPerspective')}</Select.Item>
                            <Select.Item value="topOrthographic">{t('viewModeTopOrthographic')}</Select.Item>
                          </Select.Content>
                        </Select.Root>
                      </Flex>
                      <Box>
                        <Text size="1">{t('topClipMinY', { value: topClipRange.minY })}</Text>
                        <Slider
                          value={[topClipRange.minY]}
                          min={TOP_CLIP_MIN_Y}
                          max={TOP_CLIP_MAX_Y}
                          step={TOP_CLIP_STEP}
                          onValueChange={([v]) => setTopClipMinY(v)}
                        />
                        <Text mt="2" size="1">{t('topClipMaxY', { value: topClipRange.maxY })}</Text>
                        <Slider
                          mt="1"
                          value={[topClipRange.maxY]}
                          min={TOP_CLIP_MIN_Y}
                          max={TOP_CLIP_MAX_Y}
                          step={TOP_CLIP_STEP}
                          onValueChange={([v]) => setTopClipMaxY(v)}
                        />
                        <Button mt="2" size="1" variant="soft" onClick={resetTopClipRange}>{t('topClipReset')}</Button>
                      </Box>
                      <Box>
                        <Text size="1">{t('timeOfDay', { value: timeOfDay.toFixed(2) })}</Text>
                        <Slider value={[timeOfDay]} min={0} max={1} step={0.01} onValueChange={([v]) => setTimeOfDay(v)} />
                      </Box>
                      <Flex gap="2" align="end">
                        {(['x', 'y', 'z'] as Axis[]).map((axis) => (
                          <Box key={axis} style={{ flex: 1, minWidth: 0 }}>
                            <Text as="label" size="1" htmlFor={`coord-${axis}`} style={{ display: 'block', marginBottom: 4 }}>
                              {axis.toUpperCase()}
                            </Text>
                            <TextField.Root
                              id={`coord-${axis}`}
                              size="1"
                              type="number"
                              value={coordDraft[axis]}
                              onChange={(e) => setAxis(axis, e.currentTarget.value)}
                            />
                          </Box>
                        ))}
                      </Flex>
                      <Flex gap="2" align="end">
                        {(['yaw', 'pitch'] as AngleAxis[]).map((axis) => (
                          <Box key={axis} style={{ flex: 1, minWidth: 0 }}>
                            <Text as="label" size="1" htmlFor={`angle-${axis}`} style={{ display: 'block', marginBottom: 4 }}>
                              {axis === 'yaw' ? 'Yaw' : 'Pitch'}
                            </Text>
                            <TextField.Root
                              id={`angle-${axis}`}
                              size="1"
                              type="number"
                              value={angleDraft[axis]}
                              min={axis === 'yaw' ? -180 : -89.4}
                              max={axis === 'yaw' ? 180 : 89.4}
                              step={1}
                              onChange={(e) => setAngleAxis(axis, e.currentTarget.value)}
                            />
                          </Box>
                        ))}
                        <Button size="1" variant="soft" onClick={useCurrentPosition}>{t('current')}</Button>
                        <Button size="1" disabled={!draftValid} onClick={applyPosition}>{t('go')}</Button>
                      </Flex>
                    </Flex>
                  </Tabs.Content>
                  <Tabs.Content value="settings">
                    <Flex direction="column" gap="3">
                      <Flex gap="2" align="center">
                        <Text size="1" style={{ width: 64 }}>{t('language')}</Text>
                        <Select.Root value={i18n.resolvedLanguage ?? i18n.language} onValueChange={changeLanguage}>
                          <Select.Trigger style={{ flex: 1 }} />
                          <Select.Content>
                            {languageOptions.map((l) => <Select.Item key={l.value} value={l.value}>{l.label}</Select.Item>)}
                          </Select.Content>
                        </Select.Root>
                      </Flex>
                      <Flex gap="2" align="center">
                        <Text size="1" style={{ width: 64 }}>{t('diagnostics')}</Text>
                        <Select.Root value={diagnosticDetail} onValueChange={(value) => setDiagnosticDetail(value as DiagnosticDetail)}>
                          <Select.Trigger style={{ flex: 1 }} />
                          <Select.Content>
                            <Select.Item value="off">{t('diagnosticsOff')}</Select.Item>
                            <Select.Item value="simple">{t('diagnosticsSimple')}</Select.Item>
                            <Select.Item value="standard">{t('diagnosticsStandard')}</Select.Item>
                            <Select.Item value="detailed">{t('diagnosticsDetailed')}</Select.Item>
                          </Select.Content>
                        </Select.Root>
                      </Flex>
                      <Flex gap="2" align="center">
                        <Text size="1" style={{ width: 64 }}>{t('schedulerPreset')}</Text>
                        <Select.Root value={schedulerPreset} onValueChange={(value) => setSchedulerPreset(value as SchedulerPreset)}>
                          <Select.Trigger style={{ flex: 1 }} />
                          <Select.Content>
                            <Select.Item value="potato">{t('schedulerPreset_potato')}</Select.Item>
                            <Select.Item value="low">{t('schedulerPreset_low')}</Select.Item>
                            <Select.Item value="medium">{t('schedulerPreset_medium')}</Select.Item>
                            <Select.Item value="high">{t('schedulerPreset_high')}</Select.Item>
                            <Select.Item value="extreme">{t('schedulerPreset_extreme')}</Select.Item>
                          </Select.Content>
                        </Select.Root>
                      </Flex>
                      <Flex gap="2" align="center" justify="between">
                        <Text as="label" size="1" htmlFor="debug-logging-toggle">{t('debugLogging')}</Text>
                        <Switch id="debug-logging-toggle" checked={debugLoggingEnabled} onCheckedChange={setDebugLoggingEnabledState} />
                      </Flex>
                      <Flex gap="2">
                        <Button size="1" variant="soft" onClick={clearDebugLog}>{t('clearDebugLog')}</Button>
                      </Flex>
                      <Box>
                        <Text size="1" weight="bold">{t('diagnosticSnapshot')}</Text>
                        <Text size="1" color="gray" style={{ display: 'block', marginTop: 4 }}>
                          {t('diagnosticSnapshotHint')}
                        </Text>
                        <Flex gap="2" mt="2" wrap="wrap">
                          <Button size="1" variant="soft" onClick={handleDownloadDiagnosticSnapshot} disabled={!diagnosticSnapshotAvailable}>
                            {t('downloadDiagnosticSnapshot')}
                          </Button>
                          <Button
                            size="1"
                            variant="soft"
                            onClick={handleUploadDiagnosticSnapshot}
                            disabled={!diagnosticSnapshotAvailable || !diagnosticServerToken.trim() || diagnosticUploadStatus === 'uploading'}
                          >
                            {diagnosticUploadStatus === 'uploading' ? t('uploadingDiagnosticSnapshot') : t('uploadDiagnosticSnapshot')}
                          </Button>
                        </Flex>
                        <Text as="label" size="1" htmlFor="diagnostic-server-token" style={{ display: 'block', marginTop: 10, marginBottom: 4 }}>
                          {t('diagnosticServerToken')}
                        </Text>
                        <TextField.Root
                          id="diagnostic-server-token"
                          size="1"
                          type="password"
                          autoComplete="off"
                          value={diagnosticServerToken}
                          placeholder={t('diagnosticServerTokenHint')}
                          onChange={(event) => setDiagnosticToken(event.currentTarget.value)}
                        />
                        {diagnosticUploadStatus !== 'idle' && diagnosticUploadStatus !== 'uploading' && (
                          <Text size="1" color={diagnosticUploadStatus === 'uploaded' ? 'green' : 'red'} style={{ display: 'block', marginTop: 6, wordBreak: 'break-word' }}>
                            {diagnosticUploadStatus === 'uploaded'
                              ? t('diagnosticUploaded', { id: diagnosticUploadMessage })
                              : t('diagnosticUploadFailed', { message: diagnosticUploadMessage })}
                          </Text>
                        )}
                      </Box>
                      <Box>
                        <Text size="1" weight="bold">{t('meshCache')}</Text>
                        <Flex gap="2" wrap="wrap" mt="2">
                          <Badge color="blue">{t('cacheEntries', { value: cacheStats.entries })}</Badge>
                          <Badge color="green">{t('cacheSize', { value: formatBytes(cacheStats.bytes) })}</Badge>
                        </Flex>
                        <Flex gap="2" mt="3">
                          <Button size="1" variant="soft" onClick={refreshCacheStats}>{t('refreshCache')}</Button>
                          <Button size="1" color="red" variant="soft" onClick={handleClearCache}>{t('clearCache')}</Button>
                        </Flex>
                      </Box>
                    </Flex>
                  </Tabs.Content>
                </Box>
              </Tabs.Root>
            )}
          </Flex>
        </Card>
        {diagnosticDetail !== 'off' && (
          <Card style={{
            position: 'absolute',
            top: 12,
            right: 12,
            width: diagnosticCollapsed ? 48 : 300,
            opacity: 0.94,
            backgroundColor: 'rgba(5, 9, 18, 0.88)',
            borderColor: 'rgba(148, 163, 184, 0.22)',
            transition: 'width 140ms ease',
          }}>
            <Flex direction="column" gap="2">
              <Flex justify="between" align="center">
                {!diagnosticCollapsed && <Text size="2" weight="bold">{t('diagnostics')}</Text>}
                <Button
                  size="1"
                  variant="ghost"
                  aria-label={diagnosticCollapsed ? t('expandDiagnostics') : t('collapseDiagnostics')}
                  onClick={() => setDiagnosticCollapsed((v) => !v)}
                  style={{ width: 28, height: 28, padding: 0, marginLeft: diagnosticCollapsed ? -4 : 0 }}
                >
                  {diagnosticCollapsed ? 'i' : 'x'}
                </Button>
              </Flex>
              {!diagnosticCollapsed && (
                <Flex gap="2" wrap="wrap">
                  <Badge>XYZ {stats.pos.map((v) => v.toFixed(0)).join(' / ')}</Badge>
                  <Badge color="green">{t('lodChunks', { rendered: stats.lodRendered, ready: stats.lodReady })}</Badge>
                  <Badge color="jade">{t('fullChunks', { rendered: stats.fullRendered, ready: stats.fullReady })}</Badge>
                  <Badge color="amber">{t('meshBytesRendered', { value: formatBytes(stats.displayedMeshBytes) })}</Badge>
                  {showStandardDiagnostics && (
                    <>
                      <Badge color="cyan">{t('trackedChunks', { value: stats.trackedChunks })}</Badge>
                      <Badge color="blue">{t('nbtChunks', { value: stats.nbt })}</Badge>
                      <Badge color="gray">{t('queueStats', { hash: stats.hashQueued, fetch: stats.fetchQueued, mesh: stats.meshQueued })}</Badge>
                      <Badge color="orange">{t('workerStats', {
                        workers: stats.workerCount,
                        copies: stats.workerChunkCopies,
                        active: stats.activeMeshTasks,
                      })}</Badge>
                    </>
                  )}
                  {showDetailedDiagnostics && (
                    <>
                      <Badge color="purple">{t('profileFetch', {
                        hash: formatMs(stats.hashFetchMsAvg),
                        chunk: formatMs(stats.chunkFetchMsAvg),
                      })}</Badge>
                      <Badge color="pink">{t('profileMesh', {
                        parse: formatMs(stats.parseMsAvg),
                        full: formatMs(stats.fullMeshMsAvg),
                        lod: formatMs(stats.lodMeshMsAvg),
                      })}</Badge>
                      <Badge color="cyan">{t('chunkBytesFetched', { value: formatBytes(stats.chunkBytesFetched) })}</Badge>
                      <Badge color="blue">{t('cacheEntries', { value: cacheStats.entries })}</Badge>
                      <Badge color="green">{t('cacheSize', { value: formatBytes(cacheStats.bytes) })}</Badge>
                      <Box style={{
                        width: '100%',
                        maxHeight: 168,
                        overflowY: 'auto',
                        borderTop: '1px solid rgba(148, 163, 184, 0.22)',
                        paddingTop: 8,
                      }}>
                        <Text size="1" weight="bold" style={{ display: 'block', marginBottom: 6 }}>{t('diagnosticEvents')}</Text>
                        {stats.diagnostics.length === 0 ? (
                          <Text size="1" color="gray">{t('noDiagnosticEvents')}</Text>
                        ) : stats.diagnostics.map((event) => (
                          <Box key={event.id} mb="1">
                            <Text size="1" color={event.kind === 'slow' ? 'amber' : 'orange'}>
                              {formatTime(event.time)} {t(event.kind === 'slow' ? 'diagnosticSlow' : 'diagnosticDelayed')}{' '}
                              {t(`diagOp_${event.op}`)} {formatMs(event.durationMs)}
                            </Text>
                            <Text size="1" color="gray" style={{ display: 'block' }}>
                              {t('diagnosticThreshold', {
                                threshold: formatMs(event.thresholdMs),
                                samples: event.sampleCount,
                              })} - {event.detail}
                            </Text>
                          </Box>
                        ))}
                      </Box>
                    </>
                  )}
                </Flex>
              )}
            </Flex>
          </Card>
        )}
      </Box>
    </Theme>
  );
}
