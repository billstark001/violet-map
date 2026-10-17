import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { Pool } from 'pg';
import { serve } from '@hono/node-server';
import { connectDatabase } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrations.js';
import { createUserService } from '../../src/users.js';
import { createApp } from '../../src/app.js';
import { createServices } from '../../src/services.js';
import { loadServerConfig } from '../../src/configuration.js';

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
  const config = loadServerConfig({
    env: {
      DATA_DIR: root,
      WORLDS_DIR: path.join(root, 'worlds'),
      ROOT_USERNAME: 'operator',
      ROOT_PASSWORD: 'operator-password',
    },
    cwd: root,
  });
  const services = await createServices(config, {
    database: () => ({ getDatabase: async () => database, closeDatabase: async () => {} }),
  });
  const app = createApp(config, services);
  return { root, options, database, service, app, storage: services.mounts.worlds };
}
export async function serveManagement(t: TestContext, fixture: Awaited<ReturnType<typeof managementFixture>>) {
  const { app, storage } = fixture;
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
