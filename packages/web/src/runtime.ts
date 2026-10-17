import { signal } from '@preact/signals';
import {
  normalizeApiBaseUrl,
  apiUrl as resolveApiUrl,
  resolveApiResourceUrl as resolveResource,
  parseFrontendRuntimeConfig,
  parseServiceCapabilities,
  LEGACY_SERVICE_CAPABILITIES,
  type ServiceCapabilities,
} from '@violet-map/core/contracts';

const origin = typeof location === 'undefined' ? 'http://localhost' : location.origin;
const baseUrl = signal(normalizeApiBaseUrl('/', origin));
export const capabilities = signal<ServiceCapabilities | undefined>(undefined);
export const mediaDelivery = signal<'proxy' | 'public'>('public');

export function apiUrl(path: string): string {
  return resolveApiUrl(baseUrl.value, path);
}

export function resolveApiResourceUrl(resource: string): string {
  return resolveResource(baseUrl.value, resource);
}

export function apiFetch(path: string, init?: RequestInit) {
  return fetch(apiUrl(path), { ...init, credentials: 'omit' });
}

export function apiTokenKey(name: string): string {
  return `violet-map:${name}:${baseUrl.value}`;
}

export function serviceCapabilities(): ServiceCapabilities {
  if (!capabilities.value) throw new Error('service capabilities have not been loaded');
  return capabilities.value;
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
  mediaDelivery.value = config.mediaDelivery ?? 'public';
  baseUrl.value = normalizeApiBaseUrl(
    config.apiBaseUrl ?? options.fallbackApi ?? import.meta.env?.VITE_API_BASE_URL ?? '/',
    currentOrigin,
  );
  const result = await apiFetch('api/capabilities');
  if (result.status === 404 && config.capabilityFallback !== 'error')
    capabilities.value = { ...LEGACY_SERVICE_CAPABILITIES };
  else {
    if (!result.ok) throw new Error(`API capabilities: HTTP ${result.status}`);
    capabilities.value = parseServiceCapabilities(await result.json());
  }
}

export function showStartupError(error: unknown) {
  const root = document.getElementById('root')!;
  root.replaceChildren();
  root.style.cssText =
    'padding:24px;color:#eee;background:#19151f;box-sizing:border-box;overflow:auto;pointer-events:auto';
  const message = document.createElement('p');
  message.textContent = `Unable to connect to Violet Map: ${error instanceof Error ? error.message : String(error)}`;
  const retry = document.createElement('button');
  retry.textContent = 'Retry';
  retry.onclick = () => location.reload();
  root.append(message, retry);
}
