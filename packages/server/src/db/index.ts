import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePg, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite, type PgliteDatabase } from 'drizzle-orm/pglite';
import { Pool } from 'pg';
import { config } from '../config.js';
import * as schema from './schema.js';

const schemaSql = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    role TEXT NOT NULL,
    issued_by TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS credentials_token_hash_idx ON credentials(token_hash);
  CREATE INDEX IF NOT EXISTS credentials_user_id_idx ON credentials(user_id);
  CREATE INDEX IF NOT EXISTS credentials_expires_at_idx ON credentials(expires_at);
`;

export interface DatabaseContext {
  /** Drizzle is intentionally shared between PGlite and node-postgres drivers. */
  db: NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;
  driver: 'pglite' | 'postgres';
  close(): Promise<void>;
}

let databasePromise: Promise<DatabaseContext> | undefined;

export function getDatabase(): Promise<DatabaseContext> {
  if (!databasePromise) databasePromise = createDatabase();
  return databasePromise;
}

async function createDatabase(): Promise<DatabaseContext> {
  if (config.databaseUrl) {
    const pool = new Pool({ connectionString: config.databaseUrl });
    await pool.query(schemaSql);
    return {
      db: drizzlePg({ client: pool, schema }),
      driver: 'postgres',
      close: () => pool.end(),
    };
  }
  const client = await PGlite.create(config.databaseDir);
  await client.exec(schemaSql);
  return {
    db: drizzlePglite({ client, schema }),
    driver: 'pglite',
    close: async () => { await client.close(); },
  };
}

export async function closeDatabase(): Promise<void> {
  if (!databasePromise) return;
  const database = await databasePromise;
  databasePromise = undefined;
  await database.close();
}
