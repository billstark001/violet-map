import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import * as schema from './schema.js';

export interface DatabaseOptions {
  databaseUrl?: string;
  databaseDir: string;
}

interface Connection {
  query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export type DatabaseContext = Connection &
  (
    | { driver: 'postgres'; db: NodePgDatabase<typeof schema>; client: Pool | PoolClient }
    | { driver: 'pglite'; db: PgliteDatabase<typeof schema>; client: PGlite }
  );

/** The lock is shared by services and maintenance, including paths containing symlinks.
 * Never reclaim a lock by age: a suspended process may still own a live database. */
async function lockDirectory(directory: string): Promise<() => Promise<void>> {
  await fs.mkdir(directory, { recursive: true });
  const canonical = await fs.realpath(directory);
  const lock = `${canonical}.lock`;
  try {
    await fs.mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error(
      `PGlite directory is locked: ${lock}. Stop its owner before maintenance; see database operations documentation.`,
    );
  }
  try {
    await fs.writeFile(
      path.join(lock, 'owner.json'),
      JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() }),
    );
  } catch (error) {
    await fs.rm(lock, { recursive: true, force: true });
    throw error;
  }
  return () => fs.rm(lock, { recursive: true, force: true });
}

export function postgresContext(
  client: Pool | PoolClient,
  close: () => Promise<void>,
): DatabaseContext & { driver: 'postgres' } {
  return {
    driver: 'postgres',
    client,
    db: drizzlePg({ client, schema }),
    query: async (text, params) => (await client.query(text, params)).rows,
    close,
  };
}

/** Establishes a connection only. Application schema changes belong to db:migrate. */
export async function connectDatabase(options: DatabaseOptions): Promise<DatabaseContext> {
  if (options.databaseUrl) {
    const pool = new Pool({ connectionString: options.databaseUrl, options: '-c search_path=public' });
    return postgresContext(pool, () => pool.end());
  }
  const release = await lockDirectory(options.databaseDir);
  let client: PGlite;
  try {
    client = await PGlite.create(await fs.realpath(options.databaseDir));
  } catch (error) {
    await release();
    throw error;
  }
  let closed = false;
  return {
    driver: 'pglite',
    client,
    db: drizzlePglite({ client, schema }),
    query: async <T extends Record<string, unknown>>(text: string, params?: unknown[]) =>
      (await client.query<T>(text, params)).rows,
    close: async () => {
      if (closed) return;
      closed = true;
      // If closing fails, retain the lock: another process must not open a live database.
      await client.close();
      await release();
    },
  };
}

// Fixed, project-specific advisory lock, held on the same session used for all DDL.
const migrationLock = '714649806726337';

export async function withMigrationLock<T>(
  database: DatabaseContext,
  run: (locked: DatabaseContext) => Promise<T>,
): Promise<T> {
  if (database.driver === 'pglite') return run(database);
  if (!(database.client instanceof Pool)) throw new Error('Migration locking requires a dedicated pool checkout');
  const client = await database.client.connect();
  let releaseError: Error | undefined;
  try {
    const result = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [migrationLock]);
    if (!result.rows[0].locked)
      throw new Error('Another database maintenance operation holds the migration lock; retry after it finishes.');
    try {
      return await run(postgresContext(client, async () => {}));
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [migrationLock]);
      } catch (error) {
        releaseError = error as Error;
      }
    }
  } finally {
    client.release(releaseError);
  }
}
