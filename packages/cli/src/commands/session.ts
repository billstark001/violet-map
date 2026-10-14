import { randomUUID } from 'node:crypto';
import type { IssuedCredential } from '@violet-map/server/contracts';
import type { CliContext } from '../context.js';
import { readSecret } from '../input.js';
import { apiRequest, ApiError, jsonRequest, remoteOrigin, resolveServerConnection } from '../remote.js';
import { editConfig } from '../settings/config.js';
import { editState, loadState } from '../settings/state.js';
import { sessionKey, sensitiveValue } from '../settings/secrets.js';

export async function login(
  context: CliContext,
  options: { username: string; passwordStdin?: boolean; passwordFile?: string },
) {
  if (!context.profileName) throw new Error('Login requires --profile or a configured default profile');
  const url = remoteOrigin(context);
  const password = await readSecret({ stdin: options.passwordStdin, file: options.passwordFile }, 'Password');
  const credential = await apiRequest<IssuedCredential>(
    { url },
    '/api/auth/login',
    jsonRequest('POST', { username: options.username, password }),
  );
  if (
    !credential ||
    typeof credential.token !== 'string' ||
    !Number.isFinite(Date.parse(credential.expiresAt)) ||
    !credential.user?.username
  )
    throw new Error('Invalid login response');
  sensitiveValue(credential.token);
  const key = sessionKey(context.profileName, url);
  const previous = (await loadState(context.paths)).sessions[key];
  const secret = `login-${randomUUID()}`;
  try {
    await context.secrets.set(secret, credential.token);
    await editConfig(context.paths, (config) => {
      config.profiles[context.profileName!] = { ...config.profiles[context.profileName!], server: { url } };
    });
    await editState(context.paths, (state) => {
      state.sessions[key] = {
        profile: context.profileName!,
        url,
        username: credential.user.username,
        expiresAt: credential.expiresAt,
        secret,
      };
    });
  } catch (error) {
    await apiRequest({ url, token: credential.token }, '/api/auth/logout', jsonRequest('POST')).catch(() => {});
    await context.secrets.delete(secret).catch(() => {});
    throw error;
  }
  if (previous) {
    try {
      await context.secrets.delete(previous.secret);
    } catch {
      console.error(
        `Login saved; the previous local credential remains as ${previous.secret}. Delete it when its backend is available.`,
      );
    }
  }
  console.log(
    JSON.stringify(
      {
        username: credential.user.username,
        role: credential.user.role,
        expiresAt: credential.expiresAt,
        profile: context.profileName,
        server: url,
      },
      null,
      2,
    ),
  );
}
export async function whoami(context: CliContext) {
  console.log(JSON.stringify(await apiRequest(await resolveServerConnection(context), '/api/auth/me'), null, 2));
}
export async function logout(context: CliContext, local = false) {
  const url = remoteOrigin(context);
  const key = sessionKey(context.profileName ?? '', url);
  const session = (await loadState(context.paths)).sessions[key];
  if (!local) {
    const connection =
      session && !context.options.serverTokenRef && context.env.VIOLET_SERVER_TOKEN === undefined
        ? { url, token: await context.secrets.get(session.secret), session: key }
        : await resolveServerConnection(context);
    try {
      await apiRequest(connection, '/api/auth/logout', jsonRequest('POST'));
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) throw error;
    }
    if (!connection.session) {
      console.log('Credential revoked.');
      return;
    }
  }
  if (session) {
    await context.secrets.delete(session.secret);
    await editState(context.paths, (state) => {
      delete state.sessions[key];
    });
  }
  console.log(local ? 'Saved login removed locally.' : 'Logged out and credential revoked.');
}
