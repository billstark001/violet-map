import {
  normalizeApiBaseUrl,
  parseFrontendRuntimeConfig,
  parseServiceCapabilities,
  apiUrl as resolveApiUrl,
  type ServiceCapabilities,
} from '@violet-map/core/contracts';

const origin = typeof location === 'undefined' ? 'http://localhost' : location.origin;
let baseUrl = normalizeApiBaseUrl('/', origin);
let capabilities: ServiceCapabilities | undefined;

export function apiUrl(path: string): string {
  return resolveApiUrl(baseUrl, path);
}

export function apiFetch(path: string, init?: RequestInit) {
  return fetch(apiUrl(path), { ...init, credentials: 'omit' });
}

export function apiTokenKey(name: string): string {
  return `violet-map:${name}:${baseUrl}`;
}

export function serviceCapabilities(): ServiceCapabilities {
  if (!capabilities) throw new Error('service capabilities have not been loaded');
  return capabilities;
}

export async function initializeRuntime(options: { staticBase?: string; fallbackApi?: string; origin?: string } = {}) {
  const currentOrigin = options.origin ?? origin;
  const staticBase = options.staticBase ?? import.meta.env?.BASE_URL ?? '/';
  const response = await fetch(new URL(`${staticBase.replace(/\/?$/, '/')}runtime-config.json`, currentOrigin), {
    cache: 'no-store',
    credentials: 'omit',
  });
  if (response.status !== 404 && !response.ok) throw new Error(`runtime-config.json: HTTP ${response.status}`);
  const config = response.status === 404 ? {} : parseFrontendRuntimeConfig(await response.json());
  baseUrl = normalizeApiBaseUrl(
    config.apiBaseUrl ?? options.fallbackApi ?? import.meta.env?.VITE_API_BASE_URL ?? '/',
    currentOrigin,
  );
  const result = await apiFetch('api/capabilities');
  if (!result.ok) throw new Error(`API capabilities: HTTP ${result.status}`);
  capabilities = parseServiceCapabilities(await result.json());
}

export function showStartupError(error: unknown) {
  const root = document.getElementById('root')!;
  root.replaceChildren();
  root.style.cssText = 'padding:24px;color:#eee;background:#19151f;box-sizing:border-box;overflow:auto';
  const message = document.createElement('p');
  message.textContent = `Unable to connect to Violet Map: ${error instanceof Error ? error.message : String(error)}`;
  const retry = document.createElement('button');
  retry.textContent = 'Retry';
  retry.onclick = () => location.reload();
  root.append(message, retry);
}
