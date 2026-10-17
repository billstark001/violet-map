import styles from './Compass.module.css';
import { t } from './i18n';
import type { ViewMode } from './render/viewerEngine';

interface CompassProps {
  yaw: number;
  pitch: number;
  viewMode: ViewMode;
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

function headingFromYaw(yaw: number): number {
  return normalizeDegrees((-yaw * 180) / Math.PI);
}

function cardinalForHeading(heading: number): string {
  return CARDINALS[Math.round(heading / 45) % CARDINALS.length];
}

function formatDegree(value: number): string {
  const rounded = Math.round(value);
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

export function Compass({ yaw, pitch, viewMode }: CompassProps) {
  const heading = viewMode === 'perspective' ? headingFromYaw(yaw) : 0;
  const pitchDeg = (pitch * 180) / Math.PI;
  const level = Math.abs(pitchDeg) < 1.5;
  const cardinal = cardinalForHeading(heading);
  const headingText = t('compassHeadingValue', { cardinal, value: formatDegree(heading) });
  return (
    <div aria-label={t('compassHeading', { value: formatDegree(heading) })} className={styles.compass}>
      <svg width="104" height="104" viewBox="0 0 104 104" role="img" className={styles.dial}>
        <circle
          cx="52"
          cy="52"
          r="42"
          fill="rgba(8, 13, 24, 0.62)"
          stroke="rgba(226, 232, 240, 0.72)"
          stroke-width="1.4"
        />
        <circle cx="52" cy="52" r="32" fill="none" stroke="rgba(148, 163, 184, 0.32)" stroke-width="1" />
        {Array.from({ length: 24 }, (_, i) => {
          const angle = i * 15;
          const major = i % 6 === 0;
          return (
            <line
              key={angle}
              x1="52"
              y1={major ? '12' : '16'}
              x2="52"
              y2="20"
              stroke={major ? 'rgba(248, 250, 252, 0.88)' : 'rgba(203, 213, 225, 0.5)'}
              stroke-width={major ? 1.8 : 1}
              transform={`rotate(${angle} 52 52)`}
            />
          );
        })}
        <text x="52" y="18" text-anchor="middle" font-size="12" font-weight="700" fill="#fca5a5">
          N
        </text>
        <text x="88" y="56" text-anchor="middle" font-size="10" font-weight="600" fill="rgba(226, 232, 240, 0.78)">
          E
        </text>
        <text x="52" y="91" text-anchor="middle" font-size="10" font-weight="600" fill="rgba(226, 232, 240, 0.72)">
          S
        </text>
        <text x="16" y="56" text-anchor="middle" font-size="10" font-weight="600" fill="rgba(226, 232, 240, 0.78)">
          W
        </text>
        <g transform={`rotate(${heading} 52 52)`}>
          <path
            d="M52 15 L59 52 L52 47 L45 52 Z"
            fill="#ef4444"
            stroke="rgba(255, 255, 255, 0.76)"
            stroke-width="0.8"
          />
          <path
            d="M52 89 L45 52 L52 57 L59 52 Z"
            fill="rgba(226, 232, 240, 0.86)"
            stroke="rgba(15, 23, 42, 0.55)"
            stroke-width="0.8"
          />
        </g>
        <circle cx="52" cy="52" r="4.4" fill="#f8fafc" stroke="rgba(15, 23, 42, 0.75)" stroke-width="1" />
      </svg>
      <div className={styles.heading}>{headingText}</div>
      {viewMode === 'perspective' && (
        <div className={styles.pitch}>
          {level ? t('compassLevel') : t('compassPitch', { value: formatDegree(pitchDeg) })}
        </div>
      )}
    </div>
  );
}
