import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cliPaths } from '../src/settings/paths.js';
import { emptyConfig, editConfig, loadConfig, validateConfig, serverOrigin } from '../src/settings/config.js';
import { SecretStore, sessionKey, redact } from '../src/settings/secrets.js';
import { editState, loadState } from '../src/settings/state.js';
import { loadContext } from '../src/context.js';
import { resolveServerConnection } from '../src/remote.js';

async function directory(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-settings-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test('CLI home isolates state; config override changes only the configuration file', async (t) => {
  const root = await directory(t);
  const paths = cliPaths(
    { cliHome: path.join(root, 'argument'), config: path.join(root, 'explicit.json') },
    { VIOLET_MAP_CLI_HOME: path.join(root, 'environment') },
  );
  assert.equal(paths.stateFile, path.join(root, 'argument/state.json'));
  assert.equal(paths.configFile, path.join(root, 'explicit.json'));
  assert.equal(paths.cacheDir, path.join(root, 'argument/cache'));
  assert.notEqual(paths.namespace, cliPaths({ cliHome: path.join(root, 'other') }).namespace);
  assert.deepEqual(await fs.readdir(root), []);
});
test('configuration validates profiles and excludes inline secrets', async (t) => {
  const root = await directory(t);
  const paths = cliPaths({ cliHome: root });
  await Promise.all(
    ['one', 'two', 'three'].map((name) =>
      editConfig(paths, (value) => {
        value.profiles[name] = { server: { url: 'https://example.test' } };
      }),
    ),
  );
  assert.deepEqual(Object.keys((await loadConfig(paths)).profiles).sort(), ['one', 'three', 'two']);
  assert.throws(
    () =>
      validateConfig({
        ...emptyConfig(),
        profiles: { bad: { server: { url: 'https://example.test', token: 'never-inline' } } },
      }),
    /Unknown field/,
  );
  assert.throws(() => serverOrigin('https://username:secret@example.test'), /without credentials/);
  assert.throws(() => serverOrigin('https://example.test/api'), /without credentials/);
  await fs.writeFile(paths.configFile, '{broken');
  await assert.rejects(loadConfig(paths), /Invalid JSON/);
  assert.equal(await fs.readFile(paths.configFile, 'utf8'), '{broken');
});
test('file credentials are private, referenceable, redacted, and absent from public state', async (t) => {
  const root = await directory(t);
  const paths = cliPaths({ cliHome: root });
  const store = new SecretStore(paths, 'file', { TOKEN_INPUT: 'env-token-value' });
  await Promise.all(['alpha', 'beta', 'gamma'].map((name) => store.set(name, `${name}-secret-value`)));
  assert.equal(await store.resolve('secret:alpha'), 'alpha-secret-value');
  assert.equal(await store.resolve('env:TOKEN_INPUT'), 'env-token-value');
  await fs.writeFile(path.join(root, 'injected'), 'file-token-value\n', { mode: 0o600 });
  assert.equal(await store.resolve('file:injected', root), 'file-token-value');
  await assert.rejects(store.resolve('env:MISSING'), /unavailable/);
  assert.doesNotMatch(await fs.readFile(paths.stateFile, 'utf8'), /secret-value|env-token-value|file-token-value/);
  assert.equal(
    redact('alpha-secret-value postgres://user:secret@host/db vm_someToken'),
    '[REDACTED] [REDACTED CONNECTION] [REDACTED TOKEN]',
  );
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(paths.credentialFile)).mode & 0o777, 0o600);
    await fs.chmod(paths.credentialFile, 0o644);
    await assert.rejects(store.get('alpha'), /0600/);
    await fs.chmod(paths.credentialFile, 0o600);
  }
  await store.delete('alpha');
  await assert.rejects(store.get('alpha'), /not found/);
});
test('server credentials are bound to a profile and origin and never fall back across targets', async (t) => {
  const root = await directory(t);
  const paths = cliPaths({ cliHome: root });
  await editConfig(paths, (config) => {
    config.defaultProfile = 'prod';
    config.profiles.prod = { server: { url: 'https://prod.example' } };
  });
  const store = new SecretStore(paths, 'file');
  await store.set('login-test', 'cached-token');
  const key = sessionKey('prod', 'https://prod.example');
  await editState(paths, (state) => {
    state.sessions[key] = {
      profile: 'prod',
      url: 'https://prod.example',
      username: 'operator',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      secret: 'login-test',
    };
  });
  assert.equal((await resolveServerConnection(await loadContext({ cliHome: root }, {}))).token, 'cached-token');
  await assert.rejects(
    resolveServerConnection(await loadContext({ cliHome: root, serverUrl: 'https://other.example' }, {})),
    /No login/,
  );
  await assert.rejects(
    resolveServerConnection(
      await loadContext(
        { cliHome: root, serverUrl: 'https://other.example' },
        { VIOLET_SERVER_URL: 'https://prod.example', VIOLET_SERVER_TOKEN: 'injected' },
      ),
    ),
    /different server/,
  );
  assert.equal(
    (await resolveServerConnection(await loadContext({ cliHome: root }, { VIOLET_SERVER_TOKEN: 'injected' }))).token,
    'injected',
  );
  await editState(paths, (state) => {
    state.sessions[key].expiresAt = new Date(0).toISOString();
  });
  await assert.rejects(resolveServerConnection(await loadContext({ cliHome: root }, {})), /expired/);
  assert.equal(Object.keys((await loadState(paths)).sessions).length, 1);
});
