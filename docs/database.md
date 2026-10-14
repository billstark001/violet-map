# Database administration

[Back to README](../README.md)

## Optional server library

API administration and map tools require only the CLI and core runtime dependencies. Database mode dynamically loads the optional peer `@violet-map/server`; install it in the same dependency environment as the CLI when direct access is needed. This workspace supplies it as a development dependency. `@violet-map/server/admin` exports `readAdminConfig` and `createAdminContext`, providing user CRUD and credential issuance/revocation with explicit connection ownership and `close()`. Importing it does not read deployment configuration, start HTTP, or open a database. SQL, schema checks, password processing, and user logic remain owned by server; map/storage algorithms remain owned by core.

Published/default package exports use built JavaScript. Workspace source launchers and tests use the `development` export condition. Build core, server, and CLI before using relocated production artifacts. Database maintenance is available only through the [server maintenance scripts](#database-operations), not the `violet-map` command tree or the admin library exports.

## Database drivers

Both drivers use the same versioned SQL migrations. Server startup and direct business operations verify the full migration history; initialize or upgrade the database explicitly before starting them:

- Default: persistent PGlite at `DATA_DIR/users.pglite`.
- PostgreSQL: set `DATABASE_URL` (for example `postgres://user:password@host:5432/violet_map`).

Set `DATABASE_DIR` to override the PGlite path. `DATABASE_URL` takes precedence. Never commit either database directory or a connection string containing a password.

## Database operations

Database DDL belongs to the server deployment workflow. Operators must run migrations explicitly; startup hooks, Compose and other deployment configuration never run `db:migrate` automatically (automated tests are the exception). Business management remains in the business CLI/API; its `admin`/`root` Bearer tokens do not authorize migrations. Maintenance uses the supplied database credentials or PGlite directory permissions.

| Server command | Purpose |
| --- | --- |
| `db:generate --name=<description>` | Generate SQL and Drizzle metadata from `src/db/schema.ts` during development. |
| `db:check` | Check Drizzle history consistency and the project's SQL/journal ordering rules, without connecting to a database. |
| `db:status` | Print JSON with applied/pending migrations, raw history, and integrity errors. |
| `db:migrate` | Verify all recorded timestamps and SHA-256 hashes, then apply pending migrations. |
| `db:baseline` | Verify an unversioned database against the initial migration and register that first version, preserving data. |

The toolchain is pinned to Drizzle ORM `0.45.4` and Kit `0.31.10`, using the v7 PostgreSQL snapshot/journal format. Upgrade the toolchain and migration format separately. See [Drizzle migrations](https://orm.drizzle.team/docs/migrations), [Kit check](https://orm.drizzle.team/docs/drizzle-kit-check), and [v0/v1 format changes](https://orm.drizzle.team/docs/v0-v1-changes).

Develop changes with `pnpm --filter @violet-map/server db:generate --name=<description>`, review and commit the SQL plus metadata in `packages/server/migrations`, and run `db:check`. Build again after generating migrations: the build emits JavaScript maintenance code and copies the complete migration directory into `dist`. Never edit or delete an applied migration; append a repair migration. Database migration identifiers are independent of npm package versions.

Deploy using the same `DATABASE_URL` or `DATABASE_DIR`/YAML settings used by the application:

```bash
pnpm --filter @violet-map/server build
# Stop services using this directory first when using PGlite.
pnpm --filter @violet-map/server db:status
pnpm --filter @violet-map/server db:migrate
pnpm --filter @violet-map/server start
```

Run `db:migrate` before creating the first administrator too. Status exits with code 1 for invalid history or an unversioned nonempty database; empty databases and valid pending migrations are reported successfully. Maintenance commands refuse modified, missing, duplicate, reordered, or unknown applied history. Version checks validate migration history, not arbitrary live schema drift: `db:check` and a `current` status do not certify that someone has not changed tables manually.

`db:baseline` is available for a database already matching `0000_baseline.sql` but lacking history. It compares relations, columns, types, nullability, defaults, constraints (including names), indexes, and triggers against a temporary reference database created from that initial SQL. Differences are reported without registering history. For an empty database use `db:migrate`; after a successful baseline run `db:migrate` for any subsequent versions. Baseline is a one-time operation and rejects databases that already have history. It never silently repairs structural differences.

PostgreSQL maintenance holds a project advisory lock on one dedicated connection across checking, baseline verification, and migration execution. Concurrent maintenance fails promptly and can be retried. All pending SQL and history inserts execute in the Drizzle migrator's transaction; PostgreSQL operations such as `CREATE INDEX CONCURRENTLY` that cannot run in a transaction require a separately planned deployment. Use a dedicated DDL account for maintenance and grant the runtime account business DML plus read access to migration history, for example (replace role names):

```sql
GRANT USAGE ON SCHEMA public, drizzle TO violet_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO violet_app;
GRANT SELECT ON drizzle.__drizzle_migrations TO violet_app;
-- Execute as the role that creates future migration objects:
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO violet_app;
```

PGlite holds an atomic `<canonical-database-directory>.lock` directory for the entire connection lifetime, shared by service and maintenance processes. Symlink aliases resolve to the same lock. Stop the service before maintenance; normal `SIGINT`/`SIGTERM` closes the database and releases the lock. A crashed or forcibly killed process deliberately leaves the lock intact rather than risking concurrent database access. Inspect its `owner.json`, verify the recorded host/process has stopped and no process has the database open, then remove only the stale `.lock` directory before retrying. Do not remove the database directory. No lock is reclaimed merely because it is old.

Production maintenance requires only the built `dist` directory, a package manifest with `type: module`, and server runtime dependencies. For example, from a deployed server package run `node dist/src/db/maintenance.js migrate`; `status` and `baseline` use the same entrypoint. Neither TypeScript execution nor Drizzle Kit is needed. Back up databases before deployments; recovery requiring old data uses a backup restore rather than automatic down migrations.

CI runs the initialization, unversioned-schema adoption, data upgrade, repeated execution, rollback, history-integrity and concurrent-maintenance tests on both PGlite and PostgreSQL 17, followed by a relocated JavaScript artifact test with production dependencies only. To run both drivers locally, provide an isolated PostgreSQL account with `CREATEDB` to `TEST_DATABASE_URL` and run `pnpm --filter @violet-map/server test:db`; each test creates and drops its own randomly named database. Without that variable only PostgreSQL tests are skipped.
