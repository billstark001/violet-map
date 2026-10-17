import { Compass } from './Compass';
import { t } from './i18n';
import { settings, stats, viewerError } from './state/viewer';
import { DiagnosticsPanel } from './ui/DiagnosticsPanel';
import { ViewerPanel } from './ui/ViewerPanel';
import styles from './App.module.css';

function CameraHud() {
  const viewMode = settings.state.value.viewMode;
  const { yaw, pitch } = stats.value;
  return (
    <>
      <Compass yaw={yaw} pitch={pitch} viewMode={viewMode} />
      {viewMode === 'perspective' && <div className={styles.reticle} />}
    </>
  );
}

function ViewerError() {
  const error = viewerError.value;
  return error ? (
    <div role="alert" className={styles.error}>
      {t('initFailed', { message: error })}
    </div>
  ) : null;
}

/** UI composition only. The canvas and shared loading/persistence lifecycle are
 * mounted independently in main.tsx and coordinated through signals. */
export default function App() {
  return (
    <div className={styles.app}>
      <ViewerPanel />
      <DiagnosticsPanel />
      <CameraHud />
      <ViewerError />
    </div>
  );
}
