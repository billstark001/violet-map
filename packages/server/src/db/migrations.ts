import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles, type MigrationMeta } from 'drizzle-orm/migrator';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { withMigrationLock, type DatabaseContext } from './connection.js';
import { verifyBaseline } from './baseline.js';

export const migrationsFolder = fileURLToPath(new URL('../../migrations/', import.meta.url));
const migrationConfig = { migrationsTable: '__drizzle_migrations', migrationsSchema: 'drizzle' };

export interface Migration extends MigrationMeta {
  tag: string;
}

/** Validate the v0.45/Kit v0.31 format before handing files to the pinned ORM. */
export function loadMigrations(folder = migrationsFolder): Migration[] {
  const journal = JSON.parse(fs.readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8'));
  if (
    journal.version !== '7' ||
    journal.dialect !== 'postgresql' ||
    !Array.isArray(journal.entries) ||
    !journal.entries.length
  ) {
    throw new Error('Invalid migration journal: expected PostgreSQL v7 with at least one entry');
  }
  let previous = 0;
  const tags = new Set<string>();
  for (const [index, entry] of journal.entries.entries()) {
    if (
      entry.idx !== index ||
      entry.version !== '7' ||
      !Number.isSafeInteger(entry.when) ||
      entry.when <= previous ||
      typeof entry.tag !== 'string' ||
      !new RegExp(`^${String(index).padStart(4, '0')}_[a-zA-Z0-9_-]+$`).test(entry.tag) ||
      typeof entry.breakpoints !== 'boolean' ||
      tags.has(entry.tag)
    ) {
      throw new Error(
        `Invalid migration journal entry ${index}: indexes, tags and timestamps must be unique and ordered`,
      );
    }
    previous = entry.when;
    tags.add(entry.tag);
  }
  if (journal.entries[0].tag !== '0000_baseline') throw new Error('Initial migration must be 0000_baseline');
  const files = fs.readdirSync(folder).filter((file) => file.endsWith('.sql'));
  if (files.length !== tags.size || files.some((file) => !tags.has(file.slice(0, -4)))) {
    throw new Error('Migration SQL files do not match the journal');
  }
  return readMigrationFiles({ migrationsFolder: folder }).map((migration, index) => {
    if (!migration.sql.some((statement) => statement.trim()))
      throw new Error(`Empty migration: ${journal.entries[index].tag}`);
    return { ...migration, tag: journal.entries[index].tag };
  });
}

interface HistoryRow extends Record<string, unknown> {
  id: number;
  hash: string;
  created_at: string | number | null;
}

export interface MigrationStatus {
  state: 'uninitialized' | 'legacy' | 'pending' | 'current' | 'invalid';
  applied: string[];
  pending: string[];
  history: HistoryRow[];
  issues: string[];
}

export async function publicRelations(database: DatabaseContext): Promise<string[]> {
  const rows = await database.query<{ name: string }>(`
    SELECT c.relname AS name FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    ORDER BY c.relname`);
  return rows.map((row) => row.name);
}

export async function databaseStatus(
  database: DatabaseContext,
  migrations = loadMigrations(),
): Promise<MigrationStatus> {
  const [table] = await database.query<{ name: string | null }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations')::text AS name",
  );
  const history = table.name
    ? await database.query<HistoryRow>('SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id')
    : [];
  const issues: string[] = [];
  for (const [index, row] of history.entries()) {
    const expected = migrations[index];
    if (!Number.isSafeInteger(row.id) || row.id < 1 || (index > 0 && row.id <= history[index - 1].id))
      issues.push(`Invalid history order at id ${row.id}`);
    if (!expected) {
      issues.push(`Unknown migration at history id ${row.id} (timestamp ${row.created_at})`);
    } else if (
      row.created_at === null ||
      Number(row.created_at) !== expected.folderMillis ||
      row.hash !== expected.hash
    ) {
      issues.push(`History mismatch for ${expected.tag} at id ${row.id}: timestamp or SHA-256 differs`);
    }
  }
  const applied = migrations.slice(0, history.length).map((migration) => migration.tag);
  const pending = migrations.slice(history.length).map((migration) => migration.tag);
  const state = issues.length
    ? 'invalid'
    : history.length === 0
      ? (await publicRelations(database)).length
        ? 'legacy'
        : 'uninitialized'
      : pending.length
        ? 'pending'
        : 'current';
  return { state, applied, pending, history, issues };
}

function requireValidHistory(status: MigrationStatus): void {
  if (status.issues.length) throw new Error(`Migration history is invalid:\n${status.issues.join('\n')}`);
}

export async function assertDatabaseCurrent(database: DatabaseContext): Promise<void> {
  const status = await databaseStatus(database);
  requireValidHistory(status);
  if (status.state !== 'current')
    throw new Error(
      `Database version is ${status.state}. Run server db:${status.state === 'legacy' ? 'baseline, then db:migrate' : 'migrate'} before starting the service or using direct business commands.`,
    );
}

export async function migrateDatabase(database: DatabaseContext, folder = migrationsFolder): Promise<MigrationStatus> {
  return withMigrationLock(database, async (locked) => {
    const migrations = loadMigrations(folder);
    const status = await databaseStatus(locked, migrations);
    requireValidHistory(status);
    if (status.state === 'legacy')
      throw new Error(
        'Unversioned database contains existing relations. Run server db:baseline to verify and adopt it first.',
      );
    if (status.state !== 'current') {
      const config = { ...migrationConfig, migrationsFolder: folder };
      if (locked.driver === 'postgres') await migratePg(locked.db, config);
      else await migratePglite(locked.db, config);
    }
    const result = await databaseStatus(locked, migrations);
    requireValidHistory(result);
    if (result.state !== 'current') throw new Error('Migration did not reach the expected database version');
    return result;
  });
}

export async function baselineDatabase(database: DatabaseContext, folder = migrationsFolder): Promise<MigrationStatus> {
  return withMigrationLock(database, async (locked) => {
    const migrations = loadMigrations(folder);
    const status = await databaseStatus(locked, migrations);
    requireValidHistory(status);
    if (status.history.length)
      throw new Error('Database already has migration history; baseline is only for an unversioned legacy database.');
    if (status.state !== 'legacy') throw new Error('Database is empty. Run server db:migrate instead of db:baseline.');
    await locked.query('BEGIN');
    try {
      // Hold relation locks across validation and registration so DDL cannot race adoption.
      if (locked.driver === 'postgres') {
        for (const name of ['users', 'credentials']) {
          const [relation] = await locked.query<{ name: string | null }>('SELECT to_regclass($1)::text AS name', [
            `public.${name}`,
          ]);
          if (relation.name) await locked.query(`LOCK TABLE public.${name} IN ACCESS EXCLUSIVE MODE`);
        }
      }
      await verifyBaseline(locked, migrations[0]);
      await locked.query('CREATE SCHEMA IF NOT EXISTS drizzle');
      await locked.query(
        'CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)',
      );
      await locked.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [
        migrations[0].hash,
        migrations[0].folderMillis,
      ]);
      await locked.query('COMMIT');
    } catch (error) {
      await locked.query('ROLLBACK');
      throw error;
    }
    return databaseStatus(locked, migrations);
  });
}
