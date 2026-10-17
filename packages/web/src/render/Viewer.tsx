import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ViewerController, type ViewerProps } from './viewerEngine';
export type { CameraPositionRequest, ViewerDiagnosticSnapshot, ViewerStatsPayload, ViewMode } from './viewerEngine';

/** UI error surface; WebGL and its lifecycle are owned by ViewerController. */
export function Viewer(props: ViewerProps) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const controller = useRef<ViewerController | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const viewer = new ViewerController(container.current!, latest.current, setError);
    controller.current = viewer;
    return () => {
      controller.current = null;
      viewer.dispose();
    };
  }, []);
  useEffect(() => {
    controller.current?.update(props);
  });
  return (
    <div ref={container} style={{ position: 'absolute', inset: 0 }}>
      {error && (
        <div
          role="alert"
          style={{
            position: 'fixed',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 100,
            maxWidth: 'min(560px, calc(100vw - 32px))',
            padding: '14px 18px',
            borderRadius: 8,
            color: '#fecaca',
            background: 'rgba(69, 10, 10, .96)',
            border: '1px solid #ef4444',
            textAlign: 'center',
          }}
        >
          {t('initFailed', { message: error })}
        </div>
      )}
    </div>
  );
}
