import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { Pool } from 'pg';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { connectDatabase } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrations.js';
import { createUserService } from '../../src/users.js';
import { createManagementApi } from '../../src/managementApi.js';
import { createAuthorization, REQUIRED_ROLE } from '../../src/auth.js';
import { LocalWorldStorage, cleanStoragePath } from '@violet-map/core/storage';

export async function managementFixture(t: TestContext, driver: 'pglite' | 'postgres' = 'pglite') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-management-'));
  const options = { databaseDir: path.join(root, 'users.pglite'), databaseUrl: undefined as string | undefined };
  let administration: Pool | undefined;
  let databaseName: string | undefined;
  if (driver === 'postgres') {
    administration = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    databaseName = `violet_cli_${randomUUID().replaceAll('-', '')}`;
    await administration.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.pathname = `/${databaseName}`;
    options.databaseUrl = url.toString();
  }
  const database = await connectDatabase(options);
  t.after(async () => {
    await database.close();
    if (administration) {
      await administration.query(`DROP DATABASE "${databaseName}"`);
      await administration.end();
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  // Fixtures use the server migration API, which is deliberately absent from the CLI.
  await migrateDatabase(database);
  const service = createUserService(async () => database, {
    rootUsername: 'operator',
    rootPassword: 'operator-password',
  });
  return { root, options, database, service };
}
export async function serveManagement(t: TestContext, fixture: Awaited<ReturnType<typeof managementFixture>>) {
  const app = new Hono();
  app.route('/', createManagementApi(fixture.service));
  const { requireRole } = createAuthorization(fixture.service);
  app.use('/api/admin/storage/*', requireRole(REQUIRED_ROLE.worlds));
  const storage = new LocalWorldStorage(path.join(fixture.root, 'worlds'));
  const file = (input: string) => cleanStoragePath(decodeURIComponent(input));
  app.get('/api/admin/storage/list', async (c) => c.json(await storage.list(c.req.query('prefix') ?? '')));
  app.get('/api/admin/storage/stat/*', async (c) => {
    const value = await storage.stat(file(c.req.path.slice('/api/admin/storage/stat/'.length)));
    return value ? c.json(value) : c.json({}, 404);
  });
  app.get('/api/admin/storage/files/*', async (c) => {
    const bytes = await storage.read(file(c.req.path.slice('/api/admin/storage/files/'.length)));
    return bytes ? c.body(new Uint8Array(bytes).buffer) : c.json({}, 404);
  });
  app.put('/api/admin/storage/files/*', async (c) => {
    await storage.write(
      file(c.req.path.slice('/api/admin/storage/files/'.length)),
      new Uint8Array(await c.req.arrayBuffer()),
    );
    return c.json({ ok: true });
  });
  app.delete('/api/admin/storage/files/*', async (c) => {
    await storage.delete(file(c.req.path.slice('/api/admin/storage/files/'.length)));
    return c.json({ ok: true });
  });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once('listening', resolve);
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  return { url, app, storage };
}
