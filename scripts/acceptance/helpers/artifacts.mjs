import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopProcess, waitForProcessOutput } from '../../helpers/process.mjs';
export const project = fileURLToPath(new URL('../../../', import.meta.url));
export const cleanEnv = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' };
for (const key of Object.keys(cleanEnv))
  if (
    /^(VIOLET_|DATABASE_|ROOT_|S3_|AWS_|STORAGE_|RESOURCES_|CONTENT_|DIAGNOSTICS_|DEPLOYMENT_|AUTH_|STATIC_|USERS_|ADMIN_|WORLD_|WORLDS_|DATA_|ASSETS_|MC_|CACHE_|PORT$)/.test(
      key,
    )
  )
    delete cleanEnv[key];

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
export async function boot(artifact, env, cwd, { legacySignals = false } = {}) {
  // Archived artifacts predate ephemeral-port configuration. Keep that fixture policy here.
  const port = legacySignals ? await freePort() : 0;
  const preload =
    process.platform === 'win32' && legacySignals
      ? ['--import', new URL('./legacy-signals.mjs', import.meta.url).href]
      : [];
  const child = spawn(process.execPath, [...preload, path.join(artifact, 'dist/src/index.js')], {
    cwd,
    env: { ...cleanEnv, ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  const capture = (bytes) => {
    output = (output + String(bytes)).slice(-65536);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  let marker;
  try {
    marker = await waitForProcessOutput(child, /server on :(\d+)(?=\s)/, 'server artifact', 20_000);
  } catch (error) {
    await stopProcess(child);
    throw error;
  }
  return {
    url: `http://127.0.0.1:${marker[1]}`,
    async close() {
      await stopProcess(child);
      child.stdout.off('data', capture);
      child.stderr.off('data', capture);
      assert.equal(child.exitCode, 0, output);
    },
  };
}
