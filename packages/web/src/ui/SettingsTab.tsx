import i18n, { language, languageOptions, t } from '../i18n';
import { clearDebugLog } from '../logger';
import { clearMeshCache } from '../meshCache';
import { serviceCapabilities } from '../runtime';
import { cacheStats, diagnosticProvider, refreshCacheStats, settings } from '../state/viewer';
import { browserStorage } from '../browserStorage';
import {
  diagnosticToken,
  downloadDiagnosticSnapshot,
  setDiagnosticToken,
  uploadDiagnostics,
  uploadMessage,
  uploadStatus,
} from '../state/diagnostics';
import { formatBytes } from '../format';
import { FieldGroup, SelectField, ToggleField } from './fields';
import controls from './controls.module.css';
import styles from './SettingsTab.module.css';

function DiagnosticActions() {
  const enabled = serviceCapabilities().diagnostics;
  const available = diagnosticProvider.value !== null;
  const status = uploadStatus.value;
  return (
    <FieldGroup>
      <div>
        <strong className={controls.text}>{t('diagnosticSnapshot')}</strong>
        <p className={styles.hint}>{t('diagnosticSnapshotHint')}</p>
      </div>
      <div className={styles.actions}>
        <button
          className={controls.button}
          type="button"
          data-variant="soft"
          onClick={downloadDiagnosticSnapshot}
          disabled={!available}
        >
          {t('downloadDiagnosticSnapshot')}
        </button>
        {enabled && (
          <button
            className={controls.button}
            type="button"
            data-variant="soft"
            onClick={() => {
              void uploadDiagnostics();
            }}
            disabled={!available || !diagnosticToken.value.trim() || status === 'uploading'}
          >
            {t(status === 'uploading' ? 'uploadingDiagnosticSnapshot' : 'uploadDiagnosticSnapshot')}
          </button>
        )}
      </div>
      {enabled && (
        <label className={styles.token} htmlFor="diagnostic-server-token">
          {t('diagnosticServerToken')}
          <input
            id="diagnostic-server-token"
            className={controls.input}
            type="password"
            autoComplete="off"
            value={diagnosticToken.value}
            placeholder={t('diagnosticServerTokenHint')}
            onInput={(event) => setDiagnosticToken(event.currentTarget.value)}
          />
        </label>
      )}
      {status !== 'idle' && status !== 'uploading' && (
        <p role="status" className={styles.message} data-color={status === 'uploaded' ? 'green' : 'red'}>
          {status === 'uploaded'
            ? t('diagnosticUploaded', { id: uploadMessage.value })
            : t('diagnosticUploadFailed', { message: uploadMessage.value })}
        </p>
      )}
    </FieldGroup>
  );
}

function MeshCacheActions() {
  const enabled = settings.state.value.idbCacheEnabled;
  const value = cacheStats.value;
  return (
    <FieldGroup>
      <strong className={controls.text}>{t('meshCache')}</strong>
      <div className={styles.actions}>
        <span className={controls.badge} data-color="blue">
          {t('cacheEntries', { value: value.entries })}
        </span>
        <span className={controls.badge} data-color="green">
          {t('cacheSize', { value: formatBytes(value.bytes) })}
        </span>
      </div>
      <div className={styles.actions}>
        <button
          className={controls.button}
          data-variant="soft"
          type="button"
          disabled={!enabled}
          onClick={() => {
            void refreshCacheStats();
          }}
        >
          {t('refreshCache')}
        </button>
        <button
          className={controls.button}
          data-variant="soft"
          data-color="red"
          type="button"
          onClick={() => {
            void clearMeshCache().then(refreshCacheStats).catch(console.error);
          }}
        >
          {t('clearCache')}
        </button>
      </div>
    </FieldGroup>
  );
}

export function SettingsTab() {
  const value = settings.state.value;
  return (
    <FieldGroup>
      <SelectField
        id="language-select"
        label={t('language')}
        value={language.value}
        options={languageOptions}
        onChange={(next) => {
          void i18n.changeLanguage(next);
          try {
            browserStorage('localStorage')?.setItem('violet-map:language', next);
          } catch {
            /* restricted storage */
          }
        }}
      />
      <SelectField
        id="diagnostic-detail"
        label={t('diagnostics')}
        value={value.diagnosticDetail}
        options={(['off', 'simple', 'standard', 'detailed'] as const).map((detail) => ({
          value: detail,
          label: t(
            {
              off: 'diagnosticsOff',
              simple: 'diagnosticsSimple',
              standard: 'diagnosticsStandard',
              detailed: 'diagnosticsDetailed',
            }[detail],
          ),
        }))}
        onChange={(diagnosticDetail) => settings.update({ diagnosticDetail })}
      />
      <SelectField
        id="scheduler-preset"
        label={t('schedulerPreset')}
        value={value.schedulerPreset}
        options={(['potato', 'low', 'medium', 'high', 'extreme'] as const).map((preset) => ({
          value: preset,
          label: t(`schedulerPreset_${preset}`),
        }))}
        onChange={(schedulerPreset) => settings.update({ schedulerPreset })}
      />
      <ToggleField
        id="debug-logging-toggle"
        label={t('debugLogging')}
        checked={value.debugLoggingEnabled}
        onChange={(debugLoggingEnabled) => settings.update({ debugLoggingEnabled })}
      />
      <ToggleField
        id="idb-cache-toggle"
        label={t('idbCache')}
        checked={value.idbCacheEnabled}
        onChange={(idbCacheEnabled) => settings.update({ idbCacheEnabled })}
      />
      <div>
        <button className={controls.button} data-variant="soft" type="button" onClick={clearDebugLog}>
          {t('clearDebugLog')}
        </button>
      </div>
      <DiagnosticActions />
      <MeshCacheActions />
    </FieldGroup>
  );
}
