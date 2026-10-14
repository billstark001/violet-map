import { apiUrl } from '@violet-map/core/contracts';
import type { CliContext } from './context.js';
import { serverBaseUrl } from './settings/config.js';
import { loadState } from './settings/state.js';
import { sessionKey, sensitiveValue } from './settings/secrets.js';

export interface ServerConnection {
  url: string;
  token: string;
  session?: string;
}
export function remoteOrigin(context: CliContext): string {
  const input = context.options.serverUrl ?? context.env.VIOLET_SERVER_URL ?? context.profile.server?.url;
  if (!input) throw new Error('Provide --server-url, VIOLET_SERVER_URL, or a server profile');
  return serverBaseUrl(input);
}
export async function resolveServerConnection(context: CliContext): Promise<ServerConnection> {
  const url = remoteOrigin(context);
  if (context.options.serverTokenRef)
    return { url, token: await context.secrets.resolve(context.options.serverTokenRef, process.cwd()) };
  if (context.env.VIOLET_SERVER_TOKEN !== undefined) {
    if (!context.env.VIOLET_SERVER_TOKEN) throw new Error('VIOLET_SERVER_TOKEN must not be empty');
    if (context.env.VIOLET_SERVER_URL && serverBaseUrl(context.env.VIOLET_SERVER_URL) !== url)
      throw new Error(
        'The environment credential belongs to a different server URL; supply an explicit credential reference',
      );
    return { url, token: sensitiveValue(context.env.VIOLET_SERVER_TOKEN) };
  }
  const key = sessionKey(context.profileName ?? '', url);
  const session = (await loadState(context.paths)).sessions[key];
  if (!session || session.url !== url || session.profile !== context.profileName)
    throw new Error('No login for this server and profile; run violet-map auth login or inject a server credential');
  if (!Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now())
    throw new Error('Saved login has expired; run violet-map auth login');
  return { url, token: await context.secrets.get(session.secret), session: key };
}
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export async function apiRequest<T>(
  connection: { url: string; token?: string },
  pathname: string,
  init: RequestInit = {},
): Promise<T> {
  if (!pathname.startsWith('api/')) throw new Error('Invalid API path');
  const headers = new Headers(init.headers);
  if (connection.token) headers.set('authorization', `Bearer ${connection.token}`);
  const response = await fetch(apiUrl(connection.url, pathname), {
    ...init,
    headers,
    redirect: 'error',
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const hint =
      response.status === 401
        ? 'Sign in again or replace the credential.'
        : response.status === 403
          ? 'The authenticated user lacks permission.'
          : '';
    throw new ApiError(
      response.status,
      typeof data.code === 'string' ? data.code : 'HTTP_ERROR',
      `HTTP ${response.status}: ${typeof data.error === 'string' ? data.error : 'request failed'} ${hint}`.trim(),
    );
  }
  return data as T;
}
export const jsonRequest = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
