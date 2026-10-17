import { waitForProcessOutput } from './process-startup.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { serve } from '@hono/node-server';

export const project = fileURLToPath(new URL('../../../', import.meta.url));
export const closeServer = (server: ReturnType<typeof serve>) =>
  new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    if ('closeAllConnections' in server) server.closeAllConnections();
  });
export async function serverOrigin(server: ReturnType<typeof serve>) {
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
export async function startStaticSite(root: string, name: 'web' | 'admin', base: string, api: string) {
  const dist = path.join(root, name);
  await fs.cp(path.join(project, 'packages', name, 'dist'), dist, { recursive: true });
  const child = spawn(process.execPath, [path.join(dist, 'serve.mjs'), '0', api], {
    env: { ...process.env, PORT: '0', STATIC_BASE_PATH: base, API_BASE_URL: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let match: RegExpMatchArray;
  try {
    match = await waitForProcessOutput(child, /Static Violet Map on :(\d+)(?=\/|\s)/, 'static site');
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
  const port = Number(match[1]);
  return { url: `http://127.0.0.1:${port}${base}`, dist, child };
}
