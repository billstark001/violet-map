export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  t: number;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
}

const MAX_LOG_ENTRIES = 50000;
const entries: LogEntry[] = [];
let debugEnabled = false;

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

function lineFor(entry: LogEntry): string {
  const base = `${new Date(entry.t).toISOString()} ${entry.level.toUpperCase()} ${entry.scope} ${entry.message}`;
  return entry.data === undefined ? base : `${base} ${safeJson(entry.data)}`;
}

function installWindowHook() {
  if (typeof window === 'undefined') return;
  window.__violetMapDebug = {
    setEnabled: setDebugLoggingEnabled,
    isEnabled: isDebugLoggingEnabled,
    entries: getDebugLogEntries,
    text: getDebugLogText,
    clear: clearDebugLog,
  };
}

export function setDebugLoggingEnabled(enabled: boolean) {
  debugEnabled = enabled;
  installWindowHook();
  if (enabled) log('debug', 'logger', 'enabled');
}

export function isDebugLoggingEnabled(): boolean {
  return debugEnabled;
}

export function log(level: LogLevel, scope: string, message: string, data?: unknown) {
  if (level === 'debug' && !debugEnabled) return;
  const entry: LogEntry = { t: Date.now(), level, scope, message, data };
  entries.push(entry);
  if (entries.length > MAX_LOG_ENTRIES) entries.splice(0, entries.length - MAX_LOG_ENTRIES);
  if (level === 'debug') console.debug(`[violet:${scope}] ${message}`, data ?? '');
  else if (level === 'info') console.info(`[violet:${scope}] ${message}`, data ?? '');
  else if (level === 'warn') console.warn(`[violet:${scope}] ${message}`, data ?? '');
  else console.error(`[violet:${scope}] ${message}`, data ?? '');
}

export function debugLog(scope: string, message: string, data?: unknown) {
  log('debug', scope, message, data);
}

export function getDebugLogEntries(): LogEntry[] {
  return entries.slice();
}

export function getDebugLogText(): string {
  return entries.map(lineFor).join('\n');
}

export function clearDebugLog() {
  entries.length = 0;
}

declare global {
  interface Window {
    __violetMapDebug?: {
      setEnabled(enabled: boolean): void;
      isEnabled(): boolean;
      entries(): LogEntry[];
      text(): string;
      clear(): void;
    };
  }
}

installWindowHook();
