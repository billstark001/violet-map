import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const execute = promisify(execFile);
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
export async function boot(artifact, env, cwd) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(artifact, 'dist/src/index.js')], {
    cwd,
    env: { ...cleanEnv, ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (bytes) => {
    output += bytes;
  });
  child.stderr.on('data', (bytes) => {
    output += bytes;
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(output || 'startup timeout'));
    }, 20_000);
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(output));
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on('data', (bytes) => {
      if (String(bytes).includes('server on')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const stopped = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await stopped;
      clearTimeout(timer);
      assert.equal(child.exitCode, 0, output);
    },
  };
}
