export function formatScalar(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 ms';
  return `${ms >= 10 ? ms.toFixed(0) : ms.toFixed(1)} ms`;
}

export function formatTime(time: number): string {
  return new Date(time).toLocaleTimeString([], {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
