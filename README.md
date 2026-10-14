# Violet Map

Violet Map is a browser-first Minecraft Java world explorer. It combines a Hono API, a Three.js viewer, offline asset/top-map tooling, and an optional admin console. It reads standard Java region layouts (`region`, `DIM-1`, `DIM1`, and modern `dimensions/…`) without requiring the Minecraft client to run.

## Packages

| Package | Purpose |
| --- | --- |
| `@violet-map/core` | NBT, regions, lighting, meshing, top-map code, plus the shared local/S3/server `WorldStorage` adapters. |
| `@violet-map/cli` | CLI for vanilla assets, top-map baking, profiling, and verified world-file synchronization. |
| `@violet-map/server` | Hono API, world service, storage-backed administration, and the Drizzle user database. |
| `@violet-map/web` | Three.js world viewer with worker meshing and an optional IndexedDB mesh cache. |
| `@violet-map/admin` | Admin UI for worlds, uploads, biome data, users, and temporary credentials. |

## Quick start

Requires Node.js 20.19+ (or 22.12+) and pnpm 12.

```bash
pnpm install
pnpm --filter @violet-map/server build
pnpm --filter @violet-map/server db:migrate
pnpm dev:full
```

| Service | URL                     |
| ------- | ----------------------- |
| API     | <http://localhost:3300> |
| Viewer  | <http://localhost:3305> |
| Admin   | <http://localhost:3310> |

`pnpm dev` and `pnpm start` run the server plus viewer. Use `pnpm dev:full` / `pnpm start:full` when the admin UI is also needed. Production checks are:

```bash
pnpm typecheck
pnpm version:check
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

Docker equivalents are `docker compose --profile light up` and `docker compose --profile full up`. Initialize or upgrade the database manually before starting these services; Compose does not run migrations.

## Versions and changelog

The root workspace and all five packages start at `0.1.0`. Each package's `package.json` is the source of truth for its version; executable versions are read from that metadata. Run `pnpm --filter @violet-map/cli dev --version` or `pnpm admin --version` to inspect the corresponding CLI version.

[CHANGELOG.md](CHANGELOG.md) records releases and the version policy. `pnpm version:check` validates every package's semantic version and enforces a shared MAJOR, plus a shared MINOR while MAJOR is `0`. Package PATCH versions may differ; after `1.0.0`, MINOR versions may also differ. CI runs this check.

For a coordinated release, run `pnpm version:set <version>` (for example, `pnpm version:set 0.2.0-rc.1`) to update the root and all workspace manifests. To update one package, use its exact metadata name: `pnpm version:set 0.1.1 --package @violet-map/cli`. The `--package` option may also precede the version. Both modes validate the entire proposed workspace against the version policy before writing any files; a targeted update leaves all other manifests unchanged. Add the corresponding changelog entry and run the production checks before publishing; these commands only update or validate local metadata and do not create commits, tags, or publications. Minecraft, cache, and file-format versions advance independently of package versions.

## Assets and local worlds

Extract client assets (only use Minecraft assets you are entitled to use):

```bash
pnpm --filter @violet-map/cli dev assets extract --version 1.21.4 --dir packages/server/data/assets
```

The server default expects worlds under `packages/server/data/worlds/<world-name>/`. Set `WORLDS_DIR` to use another directory. Region files can also be uploaded through Admin.

```text
<world>/
├── level.dat
├── region/r.<x>.<z>.mca
├── DIM-1/region/…
├── DIM1/region/…
└── dimensions/<namespace>/<path>/region/…
```

Additional packs are supplied with `ASSETS_DIRS=base,override`; later paths take precedence.

## Authentication and users

The server has five ordered roles: `guest`, `viewer`, `ci`, `admin`, and `root`. `guest` is anonymous/public access; it is not a creatable account. `root` is a virtual environment-managed account and is also not creatable. `viewer` can submit diagnostics, `ci` can use world/admin storage APIs, and `admin` can manage data and users. `root` includes all permissions.

Root exists only when **both** environment variables are non-empty:

```bash
ROOT_USERNAME=operator
ROOT_PASSWORD='use-a-long-unique-secret'
```

If either variable is omitted, no root account exists. Bootstrap the first normal admin through the server CLI instead:

```bash
pnpm admin users create \
  --username alice --password 'a-long-unique-password' --role admin
pnpm admin users list
pnpm admin users update --username alice --role ci
pnpm admin users delete --username alice
```

The command rejects `root` and `guest` roles. The Admin UI also provides sign-in, full user CRUD, enable/disable controls, and credential issuance. A root or admin can issue a credential bound to one enabled user for 60 seconds to 365 days; the raw token is displayed exactly once. Password login produces a 12-hour bearer credential. Send credentials with `Authorization: Bearer <token>`.

### Database drivers

Both drivers use the same versioned SQL migrations. Server startup and direct business operations verify the full migration history; initialize or upgrade the database explicitly before starting them:

- Default: persistent PGlite at `DATA_DIR/users.pglite`.
- PostgreSQL: set `DATABASE_URL` (for example `postgres://user:password@host:5432/violet_map`).

Set `DATABASE_DIR` to override the PGlite path. `DATABASE_URL` takes precedence. Never commit either database directory or a connection string containing a password.

### Database operations

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

## World storage and safe synchronization

`WorldStorage` lives in `@violet-map/core/storage` and has three interchangeable adapters:

1. `local` — a filesystem root.
2. `s3` — AWS S3 or S3-compatible object storage.
3. `server` — a remote Violet Map server through authenticated storage APIs.

The server selects `local` or `s3` with `WORLD_STORAGE`. The CLI syncs a **local world archive** to any of the three. It creates `.violet-map/identity.json` in the source archive and checks it against the target before writing. A different or missing marker on a non-empty target emits a warning and aborts unless `--force` is explicitly supplied.

```bash
# Local archive -> another filesystem worlds root
pnpm --filter @violet-map/cli dev world sync \
  --from /backups/my-world --world survival --target local \
  --target-dir /srv/violet-map/worlds --delete

# Local archive -> S3-compatible storage (credentials may also come from S3_* env vars)
pnpm --filter @violet-map/cli dev world sync \
  --from /backups/my-world --world survival --target s3 \
  --s3-endpoint https://s3.example.com --s3-bucket violet-worlds --s3-prefix production

# Local archive -> remote Violet Map server, using a CI/admin/root credential
pnpm --filter @violet-map/cli dev world sync \
  --from /backups/my-world --world survival --target server \
  --server-url https://map.example.com --server-token "$VIOLET_SERVER_TOKEN"
```

`--dry-run` prints changes without writing. `--delete` mirrors deletions from source to target. `--force` is intentionally separate and should only be used after confirming the target is the same world. Sync hashes same-size files before skipping them, so it works across local filesystems, S3 etags, and server storage consistently.

The server exposes its shared storage adapter under protected `/api/admin/storage/*` endpoints. This is what makes remote CLI sync work, while regular Admin uploads and world edits use the same adapter directly.

## CI/CD

`.github/workflows/ci.yml` installs immutable dependencies, runs lint, formatting, type checks, and focused Node tests, then builds all packages on pushes and pull requests. The tests cover storage consistency, region records, top-map mesh edges, and bounded server reads without launching a browser.

`.github/workflows/world-sync.yml` is manually dispatched. Configure repository secrets for either destination:

- Server: `VIOLET_SERVER_URL`, `VIOLET_SERVER_TOKEN`
- S3: `S3_BUCKET`, `S3_ENDPOINT` (optional), `S3_REGION`, `S3_PREFIX` (optional), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`

The workflow accepts the checked-in archive directory, target world name, destination type, and explicit `delete`/`force` switches. Use an issued CI credential with the least privilege necessary.

## Configuration

Non-sensitive values can be set as environment variables or in `violet-map.yaml` / `violet-map.yml`; use `VIOLET_MAP_CONFIG` to select another file. The file supports standard nested YAML maps and lists. A malformed file stops startup with its path in the error; environment variables take precedence. Relative paths in YAML resolve from the YAML file's directory; paths in environment variables resolve from the process working directory.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3300` | API port. |
| `WORLDS_DIR` | `data/worlds` | Local world directory. |
| `DATA_DIR` | `data` | Runtime data directory, including default PGlite data. |
| `DATABASE_URL` | unset | PostgreSQL connection string; enables PostgreSQL instead of PGlite. |
| `DATABASE_DIR` | `DATA_DIR/users.pglite` | PGlite data directory override. |
| `ROOT_USERNAME`, `ROOT_PASSWORD` | unset | Define the optional virtual root account; both are required. |
| `WORLD_STORAGE` | `local` | `local` or `s3`. |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_PREFIX` | — | World-storage S3 configuration. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | — | S3 credentials. |
| `S3_FORCE_PATH_STYLE` | `true` | Set false for virtual-hosted-style S3. |
| `ASSETS_DIRS` | bundled defaults, `data/assets` | Comma-separated resource pack directories; later directories override earlier ones. |
| `MC_VERSION` | `1.21.4` | Default version for generated data/minimal `level.dat`. |
| `MC_DATA_VERSION` | `MC_VERSION` | `minecraft-data` version override. |
| `REGION_CACHE_BYTES` | `268435456` | Full region cache cap. |
| `CHUNK_NBT_CACHE_BYTES` | `134217728` | NBT cache cap. |

Example:

```yaml
server:
  port: 3300
worldsDir: /srv/violet-map/worlds
dataDir: /srv/violet-map/data
worldStorage: s3
s3:
  endpoint: https://s3.example.com
  region: auto
  bucket: violet-worlds
  prefix: production
  forcePathStyle: true
```

Secrets (`DATABASE_URL`, root password, S3 secrets, credentials) must remain in environment variables or your deployment secret manager.

## Viewer and asset tooling

The viewer persists its selected world, camera, scheduler, diagnostics, and settings in local storage. The **Settings** tab includes **Enable IndexedDB cache**. Disabling it bypasses all mesh-cache reads and writes without deleting existing cache data; clear it explicitly if desired. Viewer initialization errors appear in the center of the screen so the tabs never obscure them.

```bash
pnpm --filter @violet-map/cli dev --help
```

| Command | Description |
| --- | --- |
| `assets list` | List available Minecraft releases. |
| `assets extract --version <id> --dir <dir>` | Download a Mojang client jar and extract blockstates/models/textures. |
| `assets extract-all --min-version <id> --dir <dir>` | Extract every selected release. |
| `assets generate-biomes --version <id> --output <file>` | Generate biome color data. |
| `assets generate-dimensions --version <id> --output <file>` | Generate standard dimension data. |
| `profile-mca <file.mca>` | Profile region parsing and meshing. |
| `bake-topmap <world>` | Bake top-map tiles and manifest under `.violet-map/top-map`. |
| `world sync …` | Sync a local archive to local/S3/server storage with identity protection. |

`bake-topmap` supports `--approach top|bottom` and `--light-mode stored-first|rebake`.

### Resource-driven special renderers

Animated block and fluid textures use their resource-pack `.png.mcmeta` animation definitions. Special blocks and entities are declared, rather than named in the viewer, in `assets/<namespace>/violet_map/renderers.json`. Each entry points at an ordinary Java model JSON under `models/`, so packs can add geometry without a code change. The bundled registrations illustrate chest and sign block entities.

```json
{
  "blockEntities": {
    "minecraft:example": {
      "model": "minecraft:violet_map/block_entity/example",
      "layer": "cutout",
      "rotationY": { "property": "facing", "values": { "north": 180, "south": 0 } }
    }
  },
  "entities": {
    "minecraft:example_mob": {
      "model": "minecraft:violet_map/entity/example_mob",
      "scale": [1, 1, 1],
      "useEntityYaw": true
    }
  }
}
```

Only registered entities are rendered. There are deliberately no built-in legacy-entity meshes; provide a modern Java-model JSON in the resource pack for each entity that should appear. Resource models are shown only for full-detail chunks in the preset-dependent near radius (potato through extreme).

## Limits

- Rendering targets modern (1.18+) `sections` / `block_states` chunk layouts.
- Biome tinting is sampled per block; radius blending is not implemented.
- Fluid surfaces approximate vanilla flow.
