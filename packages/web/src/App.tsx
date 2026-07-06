import { useEffect, useRef, useState } from 'react';
import { Badge, Box, Button, Card, Flex, Select, Slider, Tabs, Text, TextField, Theme } from '@radix-ui/themes';
import { useTranslation } from 'react-i18next';
import { fetchWorlds } from './api';
import { languageOptions } from './i18n';
import { clearMeshCache, getMeshCacheStats } from './meshCache';
import { Viewer, type CameraPositionRequest } from './render/Viewer';
import { EMPTY_CHUNK_SCHEDULER_STATS, type ChunkSchedulerStats } from './render/chunkScheduler';

interface WorldInfo { id: string; dimensions: string[] }
type Axis = 'x' | 'y' | 'z';
type DiagnosticDetail = 'off' | 'simple' | 'standard' | 'detailed';
interface ViewerStats extends ChunkSchedulerStats {
  pos: [number, number, number];
}

const SETTINGS_STORAGE_KEY = 'violet-map:settings';
const PANEL_STORAGE_KEY = 'violet-map:panel-collapsed';
const DIAGNOSTIC_PANEL_STORAGE_KEY = 'violet-map:diagnostic-panel-collapsed';

interface ViewerSettings {
  world?: string;
  dimension?: string;
  viewDistance?: number;
  lodDistance?: number;
  fastMoveMultiplier?: number;
  timeOfDay?: number;
  diagnosticDetail?: DiagnosticDetail;
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

function coordText(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const rounded = Math.round(v * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
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

export default function App() {
  const { t, i18n } = useTranslation();
  const [worlds, setWorlds] = useState<WorldInfo[]>([]);
  const [world, setWorld] = useState(() => stringSetting('world', ''));
  const [dimension, setDimension] = useState(() => stringSetting('dimension', 'minecraft:overworld'));
  const [viewDistance, setViewDistance] = useState(() => numberSetting('viewDistance', 8));
  const [lodDistance, setLodDistance] = useState(() => numberSetting('lodDistance', 12));
  const [fastMoveMultiplier, setFastMoveMultiplier] = useState(() => numberSetting('fastMoveMultiplier', 4));
  const [timeOfDay, setTimeOfDay] = useState(() => numberSetting('timeOfDay', 0));
  const [diagnosticDetail, setDiagnosticDetail] = useState<DiagnosticDetail>(() => diagnosticDetailSetting());
  const [panelCollapsed, setPanelCollapsed] = useState(() => localStorage.getItem(PANEL_STORAGE_KEY) === 'true');
  const [diagnosticCollapsed, setDiagnosticCollapsed] = useState(() => localStorage.getItem(DIAGNOSTIC_PANEL_STORAGE_KEY) === 'true');
  const [stats, setStats] = useState<ViewerStats>({ ...EMPTY_CHUNK_SCHEDULER_STATS, pos: [0, 0, 0] });
  const latestStatsRef = useRef<ViewerStats>({ ...EMPTY_CHUNK_SCHEDULER_STATS, pos: [0, 0, 0] });
  const [panelTab, setPanelTab] = useState('view');
  const [cacheStats, setCacheStats] = useState({ entries: 0, bytes: 0 });
  const [coordDirty, setCoordDirty] = useState(false);
  const [coordDraft, setCoordDraft] = useState<Record<Axis, string>>({ x: '0', y: '80', z: '0' });
  const [cameraTarget, setCameraTarget] = useState<CameraPositionRequest>();
  const [worldsLoaded, setWorldsLoaded] = useState(false);

  useEffect(() => {
    fetchWorlds().then((ws) => {
      setWorlds(ws);
      if (ws.length) {
        const selectedWorld = ws.find((w) => w.id === world)?.id ?? ws[0].id;
        const dims = ws.find((w) => w.id === selectedWorld)?.dimensions ?? [];
        setWorld(selectedWorld);
        setDimension((d) => dims.includes(d) ? d : (dims[0] ?? 'minecraft:overworld'));
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
      if (!params.has('timeOfDay')) next.timeOfDay = timeOfDay;
      if (!params.has('diagnosticDetail')) next.diagnosticDetail = diagnosticDetail;
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage may be unavailable in restricted contexts.
    }
  }, [world, dimension, viewDistance, lodDistance, fastMoveMultiplier, timeOfDay, diagnosticDetail, worldsLoaded]);

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
    const diagnosticsNeedCache = diagnosticDetail === 'detailed' && !diagnosticCollapsed;
    if (panelCollapsed && !diagnosticsNeedCache) return;
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
  }, [panelCollapsed, diagnosticDetail, diagnosticCollapsed]);

  const dims = worlds.find((w) => w.id === world)?.dimensions ?? [];
  const draftValues = [Number(coordDraft.x), Number(coordDraft.y), Number(coordDraft.z)] as const;
  const draftValid = draftValues.every(Number.isFinite);
  const diagnosticsVisible = diagnosticDetail !== 'off' && !diagnosticCollapsed;
  const showStandardDiagnostics = diagnosticDetail === 'standard' || diagnosticDetail === 'detailed';
  const showDetailedDiagnostics = diagnosticDetail === 'detailed';
  const handleStats = (next: typeof stats) => {
    latestStatsRef.current = next;
    if (diagnosticsVisible) setStats(next);
    if (!coordDirty) {
      const draft = { x: coordText(next.pos[0]), y: coordText(next.pos[1]), z: coordText(next.pos[2]) };
      setCoordDraft((prev) => (
        prev.x === draft.x && prev.y === draft.y && prev.z === draft.z ? prev : draft
      ));
    }
  };
  const setAxis = (axis: Axis, value: string) => {
    setCoordDirty(true);
    setCoordDraft((prev) => ({ ...prev, [axis]: value }));
  };
  const useCurrentPosition = () => {
    const current = latestStatsRef.current;
    setCoordDraft({ x: coordText(current.pos[0]), y: coordText(current.pos[1]), z: coordText(current.pos[2]) });
    setCoordDirty(false);
  };
  const applyPosition = () => {
    if (!draftValid) return;
    setCoordDirty(false);
    setCameraTarget({ x: draftValues[0], y: draftValues[1], z: draftValues[2], seq: Date.now() });
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

  return (
    <Theme appearance="dark" accentColor="grass" style={{ height: '100%' }}>
      <Box style={{ position: 'relative', height: '100%' }}>
        {world && (
          <Viewer
            world={world} dimension={dimension}
            viewDistance={viewDistance} lodDistance={lodDistance}
            fastMoveMultiplier={fastMoveMultiplier}
            timeOfDay={timeOfDay} cameraTarget={cameraTarget} onStats={handleStats}
          />
        )}
        {/* 准星 */}
        <div style={{
          position: 'absolute', left: '50%', top: '50%', width: 12, height: 12,
          transform: 'translate(-50%,-50%)', pointerEvents: 'none',
          background: 'radial-gradient(circle, rgba(255,255,255,.8) 0 1.5px, transparent 2px)',
        }} />
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
                        <Select.Root value={dimension} onValueChange={setDimension}>
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
