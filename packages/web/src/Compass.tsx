import { useTranslation } from 'react-i18next';
import type { ViewMode } from './render/Viewer';

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
  return normalizeDegrees(-yaw * 180 / Math.PI);
}

function cardinalForHeading(heading: number): string {
  return CARDINALS[Math.round(heading / 45) % CARDINALS.length];
}

function formatDegree(value: number): string {
  const rounded = Math.round(value);
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

export function Compass({ yaw, pitch, viewMode }: CompassProps) {
  const { t } = useTranslation();
  const heading = viewMode === 'perspective' ? headingFromYaw(yaw) : 0;
  const pitchDeg = pitch * 180 / Math.PI;
  const level = Math.abs(pitchDeg) < 1.5;
  const cardinal = cardinalForHeading(heading);
  const headingText = t('compassHeadingValue', { cardinal, value: formatDegree(heading) });

  return (
    <div
      aria-label={t('compassHeading', { value: formatDegree(heading) })}
      style={{
        position: 'absolute',
        right: 16,
        bottom: 16,
        zIndex: 5,
        width: 104,
        pointerEvents: 'none',
        userSelect: 'none',
        color: '#f8fafc',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        textShadow: '0 1px 2px rgba(0, 0, 0, 0.55)',
      }}
    >
      <svg width="104" height="104" viewBox="0 0 104 104" role="img" style={{ display: 'block' }}>
        <circle cx="52" cy="52" r="42" fill="rgba(8, 13, 24, 0.62)" stroke="rgba(226, 232, 240, 0.72)" strokeWidth="1.4" />
        <circle cx="52" cy="52" r="32" fill="none" stroke="rgba(148, 163, 184, 0.32)" strokeWidth="1" />
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
              strokeWidth={major ? 1.8 : 1}
              transform={`rotate(${angle} 52 52)`}
            />
          );
        })}
        <text x="52" y="18" textAnchor="middle" fontSize="12" fontWeight="700" fill="#fca5a5">N</text>
        <text x="88" y="56" textAnchor="middle" fontSize="10" fontWeight="600" fill="rgba(226, 232, 240, 0.78)">E</text>
        <text x="52" y="91" textAnchor="middle" fontSize="10" fontWeight="600" fill="rgba(226, 232, 240, 0.72)">S</text>
        <text x="16" y="56" textAnchor="middle" fontSize="10" fontWeight="600" fill="rgba(226, 232, 240, 0.78)">W</text>
        <g transform={`rotate(${heading} 52 52)`}>
          <path d="M52 15 L59 52 L52 47 L45 52 Z" fill="#ef4444" stroke="rgba(255, 255, 255, 0.76)" strokeWidth="0.8" />
          <path d="M52 89 L45 52 L52 57 L59 52 Z" fill="rgba(226, 232, 240, 0.86)" stroke="rgba(15, 23, 42, 0.55)" strokeWidth="0.8" />
        </g>
        <circle cx="52" cy="52" r="4.4" fill="#f8fafc" stroke="rgba(15, 23, 42, 0.75)" strokeWidth="1" />
      </svg>
      <div style={{
        margin: '-6px auto 0',
        width: 'max-content',
        maxWidth: '100%',
        padding: '4px 7px',
        borderRadius: 7,
        background: 'rgba(8, 13, 24, 0.66)',
        border: '1px solid rgba(226, 232, 240, 0.24)',
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: 0,
        textAlign: 'center',
      }}>
        {headingText}
      </div>
      {viewMode === 'perspective' && (
        <div style={{
          margin: '4px auto 0',
          width: 'max-content',
          maxWidth: '100%',
          padding: '3px 7px',
          borderRadius: 7,
          background: 'rgba(8, 13, 24, 0.58)',
          border: '1px solid rgba(226, 232, 240, 0.2)',
          fontSize: 11,
          fontWeight: 600,
          textAlign: 'center',
        }}>
          {level ? t('compassLevel') : t('compassPitch', { value: formatDegree(pitchDeg) })}
        </div>
      )}
    </div>
  );
}
