import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { connectDatabase, withMigrationLock, type DatabaseContext } from '../src/db/connection.js';
import {
  assertDatabaseCurrent,
  baselineDatabase,
  databaseStatus,
  loadMigrations,
  migrateDatabase,
  migrationsFolder,
  publicRelations,
} from '../src/db/migrations.js';

const execute = promisify(execFile);
const postgresUrl = process.env.TEST_DATABASE_URL;
const initialSql = loadMigrations()[0].sql.join('\n');

async function execSql(database: DatabaseContext, text: string): Promise<void> {
  if (database.driver === 'pglite') await database.client.exec(text);
  else await database.client.query(text);
}

async function fixture(t: TestContext, driver: 'pglite' | 'postgres') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-migrations-'));
  let admin: Pool | undefined;
  let name: string | undefined;
  let databaseUrl: string | undefined;
  if (driver === 'postgres') {
    admin = new Pool({ connectionString: postgresUrl });
    name = `violet_test_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(postgresUrl!);
    url.pathname = `/${name}`;
    databaseUrl = url.toString();
  }
  const options = { databaseUrl, databaseDir: path.join(root, 'database') };
  const database = await connectDatabase(options);
  const connections = [database];
  t.after(async () => {
    try {
      for (const connection of connections) await connection.close();
      if (admin) await admin.query(`DROP DATABASE "${name}"`);
    } finally {
      await admin?.end();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  const open = async () => {
    const connection = await connectDatabase(options);
    connections.push(connection);
    return connection;
  };
  return { database, options, root, open };
}

async function futureMigrations(root: string, statements: string[]) {
  const folder = path.join(root, `migrations-${randomUUID()}`);
  await fs.cp(migrationsFolder, folder, { recursive: true });
  const journalPath = path.join(folder, 'meta/_journal.json');
  const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  for (const statement of statements) {
    const index = journal.entries.length;
    const tag = `${String(index).padStart(4, '0')}_test_upgrade`;
    journal.entries.push({
      idx: index,
      version: '7',
      tag,
      when: journal.entries[index - 1].when + 1,
      breakpoints: true,
    });
    await fs.writeFile(path.join(folder, `${tag}.sql`), statement);
  }
  await fs.writeFile(journalPath, JSON.stringify(journal));
  return folder;
}

async function insertData(database: DatabaseContext) {
  await database.query("INSERT INTO users VALUES ('u1', 'alice', 'hash', 'admin', TRUE, '2026-01-01Z', '2026-01-01Z')");
  await database.query(
    "INSERT INTO credentials VALUES ('c1', 'token', 'u1', 'alice', 'admin', 'u1', '2027-01-01Z', '2026-01-01Z')",
  );
}

for (const driver of ['pglite', 'postgres'] as const) {
  test(`${driver}: database maintenance`, { skip: driver === 'postgres' && !postgresUrl }, async (t) => {
    await t.test('empty initialization, read-only version guard, repetition and future data upgrade', async (t) => {
      const { database, root } = await fixture(t, driver);
      assert.equal((await databaseStatus(database)).state, 'uninitialized');
      await assert.rejects(assertDatabaseCurrent(database), /db:migrate/);
      assert.deepEqual(await publicRelations(database), []);
      await assert.rejects(baselineDatabase(database), /empty/);
      assert.equal((await migrateDatabase(database)).state, 'current');
      await assertDatabaseCurrent(database);
      await insertData(database);
      assert.equal((await migrateDatabase(database)).history.length, 1);
      const folder = await futureMigrations(root, [
        "ALTER TABLE users ADD COLUMN note text NOT NULL DEFAULT 'upgraded';",
      ]);
      assert.equal((await databaseStatus(database, loadMigrations(folder))).state, 'pending');
      const upgraded = await migrateDatabase(database, folder);
      assert.equal(upgraded.history.length, 2);
      assert.deepEqual(await database.query('SELECT username, note FROM users'), [
        { username: 'alice', note: 'upgraded' },
      ]);
      assert.equal((await database.query('SELECT id FROM credentials'))[0].id, 'c1');
      assert.equal((await migrateDatabase(database, folder)).history.length, 2);
      // An older server must refuse a newer database as well.
      await assert.rejects(assertDatabaseCurrent(database), /Unknown migration/);
    });

    await t.test('adopts unversioned initial schema without touching data and can then upgrade', async (t) => {
      const { database, root } = await fixture(t, driver);
      await execSql(database, initialSql);
      await insertData(database);
      assert.equal((await databaseStatus(database)).state, 'legacy');
      await assert.rejects(migrateDatabase(database), /db:baseline/);
      const before = await database.query('SELECT * FROM users');
      const credentialBefore = await database.query('SELECT * FROM credentials');
      const folder = await futureMigrations(root, ['ALTER TABLE users ADD COLUMN note text;']);
      const adopted = await baselineDatabase(database, folder);
      assert.equal(adopted.state, 'pending');
      assert.equal(adopted.applied[0], '0000_baseline');
      assert.deepEqual(await database.query('SELECT * FROM users'), before);
      assert.deepEqual(await database.query('SELECT * FROM credentials'), credentialBefore);
      await assert.rejects(baselineDatabase(database, folder), /already has migration history/);
      assert.equal((await migrateDatabase(database, folder)).state, 'current');
    });

    await t.test('rejects baseline drift with specific column, constraint and index differences', async (t) => {
      const { database } = await fixture(t, driver);
      await execSql(database, initialSql);
      await execSql(
        database,
        `
        ALTER TABLE users ALTER COLUMN enabled SET DEFAULT false;
        ALTER TABLE users ALTER COLUMN username DROP NOT NULL;
        ALTER TABLE users ALTER COLUMN role TYPE varchar(30);
        ALTER TABLE users ADD COLUMN extra text;
        ALTER TABLE users RENAME CONSTRAINT users_username_unique TO unexpected_unique;
        DROP INDEX credentials_user_id_idx;
        CREATE INDEX credentials_user_id_idx ON credentials(username);
        ALTER TABLE credentials ADD CONSTRAINT future_expiry CHECK (expires_at > created_at);
      `,
      );
      await assert.rejects(baselineDatabase(database), (error: Error) => {
        for (const part of [
          'column:users.enabled',
          'column:users.username',
          'column:users.role',
          'column:users.extra',
          'constraint:users.users_username_unique',
          'constraint:users.unexpected_unique',
          'index:credentials.credentials_user_id_idx',
          'constraint:credentials.future_expiry',
        ]) {
          assert.ok(error.message.includes(part), error.message);
        }
        return true;
      });
      assert.equal((await databaseStatus(database)).history.length, 0);
    });

    await t.test('rolls back every pending migration and its history on SQL failure', async (t) => {
      const { database, root } = await fixture(t, driver);
      await migrateDatabase(database);
      await insertData(database);
      const folder = await futureMigrations(root, [
        'ALTER TABLE users ADD COLUMN note text;',
        'ALTER TABLE missing_table ADD COLUMN bad text;',
      ]);
      await assert.rejects(migrateDatabase(database, folder), /missing_table/);
      assert.equal((await databaseStatus(database)).history.length, 1);
      assert.equal(
        (
          await database.query(
            "SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'note'",
          )
        )[0].count,
        0,
      );
      assert.equal((await database.query('SELECT username FROM users'))[0].username, 'alice');
      // A separately fixed, still-unapplied migration can then succeed.
      await fs.writeFile(
        path.join(folder, '0002_test_upgrade.sql'),
        'ALTER TABLE users ADD COLUMN recovery boolean DEFAULT true;',
      );
      assert.equal((await migrateDatabase(database, folder)).history.length, 3);
    });

    await t.test('rejects changed SQL, missing, reordered, duplicate and unknown history', async (t) => {
      const { database, root } = await fixture(t, driver);
      const folder = await futureMigrations(root, ['ALTER TABLE users ADD COLUMN note text;']);
      await migrateDatabase(database, folder);
      const original = await database.query(
        'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id',
      );
      const migrationPath = path.join(folder, '0000_baseline.sql');
      const sql = await fs.readFile(migrationPath, 'utf8');
      await fs.appendFile(migrationPath, '\n-- changed after deployment\n');
      await assert.rejects(migrateDatabase(database, folder), /History mismatch/);
      await fs.writeFile(migrationPath, sql);
      const mutations = [
        'DELETE FROM drizzle.__drizzle_migrations WHERE id = 1',
        'UPDATE drizzle.__drizzle_migrations SET created_at = created_at + 10 WHERE id = 1',
        "UPDATE drizzle.__drizzle_migrations SET hash = 'tampered' WHERE id = 1",
        'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) SELECT hash, created_at FROM drizzle.__drizzle_migrations WHERE id = 1',
        "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('unknown', 9999999999999)",
      ];
      for (const mutation of mutations) {
        await database.query('DELETE FROM drizzle.__drizzle_migrations');
        for (const row of original)
          await database.query('INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES ($1, $2, $3)', [
            row.id,
            row.hash,
            row.created_at,
          ]);
        await database.query(mutation);
        const status = await databaseStatus(database, loadMigrations(folder));
        assert.equal(status.state, 'invalid', mutation);
        assert.ok(status.issues.length);
        await assert.rejects(migrateDatabase(database, folder), /Migration history is invalid/);
        await assert.rejects(baselineDatabase(database, folder), /Migration history is invalid/);
      }
    });

    await t.test('maintenance excludes concurrent operations and releases locks on failure', async (t) => {
      const { database, options, root, open } = await fixture(t, driver);
      if (driver === 'postgres') {
        const other = await open();
        await withMigrationLock(database, async () => {
          await assert.rejects(migrateDatabase(other), /migration lock/);
          await assert.rejects(baselineDatabase(other), /migration lock/);
          await assert.rejects(withMigrationLock(other, databaseStatus), /migration lock/);
        });
        await assert.rejects(
          withMigrationLock(database, async () => {
            throw new Error('test lock cleanup');
          }),
          /test lock cleanup/,
        );
        await migrateDatabase(other);
      } else {
        await assert.rejects(connectDatabase(options), /directory is locked/);
        const alias = path.join(root, 'alias');
        await fs.symlink(options.databaseDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
        await assert.rejects(connectDatabase({ databaseDir: alias }), /directory is locked/);
        // A separate Node process shares the lock with the service as well.
        await assert.rejects(
          execute(
            process.execPath,
            [
              '--import',
              'tsx',
              '--input-type=module',
              '-e',
              `
          import { connectDatabase } from './packages/server/src/db/connection.ts';
          const db = await connectDatabase({ databaseDir: process.env.VIOLET_TEST_DIRECTORY });
          await db.close();
        `,
            ],
            {
              cwd: new URL('../../..', import.meta.url),
              env: { ...process.env, VIOLET_TEST_DIRECTORY: options.databaseDir },
            },
          ),
          /directory is locked/,
        );
        await database.close();
        const reopened = await connectDatabase(options);
        try {
          await migrateDatabase(reopened);
        } finally {
          await reopened.close();
        }
      }
    });
  });
}

test('migration files reject orphan SQL and invalid journal order before opening a database', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-migration-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = await futureMigrations(root, ['SELECT 1;']);
  await fs.writeFile(path.join(folder, 'orphan.sql'), 'SELECT 1;');
  assert.throws(() => loadMigrations(folder), /do not match the journal/);
  await fs.rm(path.join(folder, 'orphan.sql'));
  const journalPath = path.join(folder, 'meta/_journal.json');
  const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
  journal.entries[1].when = journal.entries[0].when;
  await fs.writeFile(journalPath, JSON.stringify(journal));
  assert.throws(() => loadMigrations(folder), /must be unique and ordered/);
});
