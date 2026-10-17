import { t } from '../i18n';
import { cacheStats, diagnosticCollapsed, settings, stats } from '../state/viewer';
import { formatBytes, formatMs, formatTime } from '../format';
import { Panel } from './Panel';
import controls from './controls.module.css';
import styles from './DiagnosticsPanel.module.css';

export function DiagnosticsPanel() {
  const detail = settings.state.value.diagnosticDetail;
  if (detail === 'off') return null;
  const collapsed = diagnosticCollapsed.value;
  const value = stats.value;
  const standard = detail === 'standard' || detail === 'detailed';
  return (
    <Panel
      side="right"
      title={t('diagnostics')}
      collapsed={collapsed}
      onToggle={() => {
        diagnosticCollapsed.value = !collapsed;
      }}
      toggleLabel={t(collapsed ? 'expandDiagnostics' : 'collapseDiagnostics')}
    >
      <div className={styles.badges}>
        <span className={controls.badge}>XYZ {value.pos.map((coordinate) => coordinate.toFixed(0)).join(' / ')}</span>
        <span className={controls.badge} data-color="green">
          {t('lodChunks', { rendered: value.lodRendered, ready: value.lodReady })}
        </span>
        <span className={controls.badge} data-color="jade">
          {t('fullChunks', { rendered: value.fullRendered, ready: value.fullReady })}
        </span>
        <span className={controls.badge} data-color="amber">
          {t('meshBytesRendered', { value: formatBytes(value.displayedMeshBytes) })}
        </span>
        {standard && (
          <>
            <span className={controls.badge} data-color="cyan">
              {t('trackedChunks', { value: value.trackedChunks })}
            </span>
            <span className={controls.badge} data-color="blue">
              {t('nbtChunks', { value: value.nbt })}
            </span>
            <span className={controls.badge} data-color="gray">
              {t('queueStats', { hash: value.hashQueued, fetch: value.fetchQueued, mesh: value.meshQueued })}
            </span>
            <span className={controls.badge} data-color="orange">
              {t('workerStats', {
                workers: value.workerCount,
                copies: value.workerChunkCopies,
                active: value.activeMeshTasks,
              })}
            </span>
          </>
        )}
        {detail === 'detailed' && (
          <>
            <span className={controls.badge} data-color="purple">
              {t('profileFetch', { hash: formatMs(value.hashFetchMsAvg), chunk: formatMs(value.chunkFetchMsAvg) })}
            </span>
            <span className={controls.badge} data-color="pink">
              {t('profileMesh', {
                parse: formatMs(value.parseMsAvg),
                full: formatMs(value.fullMeshMsAvg),
                lod: formatMs(value.lodMeshMsAvg),
              })}
            </span>
            <span className={controls.badge} data-color="cyan">
              {t('chunkBytesFetched', { value: formatBytes(value.chunkBytesFetched) })}
            </span>
            <span className={controls.badge} data-color="blue">
              {t('cacheEntries', { value: cacheStats.value.entries })}
            </span>
            <span className={controls.badge} data-color="green">
              {t('cacheSize', { value: formatBytes(cacheStats.value.bytes) })}
            </span>
            <div className={styles.events}>
              <strong className={controls.text}>{t('diagnosticEvents')}</strong>
              {value.diagnostics.length === 0 ? (
                <p className={controls.text} data-color="gray">
                  {t('noDiagnosticEvents')}
                </p>
              ) : (
                value.diagnostics.map((event) => (
                  <div className={styles.event} key={event.id}>
                    <span className={controls.text} data-color={event.kind === 'slow' ? 'amber' : 'orange'}>
                      {formatTime(event.time)} {t(event.kind === 'slow' ? 'diagnosticSlow' : 'diagnosticDelayed')}{' '}
                      {t(`diagOp_${event.op}`)} {formatMs(event.durationMs)}
                    </span>
                    <p className={controls.text} data-color="gray">
                      {t('diagnosticThreshold', { threshold: formatMs(event.thresholdMs), samples: event.sampleCount })}{' '}
                      - {event.detail}
                    </p>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
