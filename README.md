# Violet Map

Violet Map is a browser-first Minecraft Java world explorer. It combines a Hono API, a Three.js viewer, offline asset/top-map tooling, and an optional admin console. It reads standard Java region layouts (`region`, `DIM-1`, `DIM1`, and modern `dimensions/…`) without requiring the Minecraft client to run.

## Packages

| Package | Purpose |
| --- | --- |
| `@violet-map/core` | NBT, regions, lighting, meshing, top-map code, plus the shared local/S3/server `WorldStorage` adapters. |
| `@violet-map/cli` | The `violet-map` CLI: assets, maps, profiles, credentials, and API/direct user administration. |
| `@violet-map/server` | Hono API, world service, database/user services, and a side-effect-free optional `server/admin` library. |
| `@violet-map/web` | Three.js world viewer with worker meshing and an optional IndexedDB mesh cache. |
| `@violet-map/admin` | Admin UI for worlds, uploads, biome data, users, and temporary credentials. |

## Quick start

Requires Node.js 24+ and pnpm 12.

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
pnpm --filter @violet-map/cli test:artifact
pnpm --filter @violet-map/server test:db:artifact
```

To exercise the real OS credential store on a machine with an unlocked keychain, run `pnpm --filter @violet-map/cli test:keychain` explicitly. This integration test uses a temporary CLI home and its isolated random keychain namespace, checks native write/read/update/delete and the application's replacement lifecycle, and verifies cleanup of every test entry and the temporary directory. It never reads or changes existing CLI credentials. It is excluded from `pnpm test` and CI because those environments may not have an accessible credential store.

Docker equivalents are `docker compose --profile light up` and `docker compose --profile full up`. Initialize or upgrade the database manually before starting these services; Compose does not run migrations.

## Versions and changelog

The root workspace and all five packages start at `0.1.0`. Each package's `package.json` is the source of truth for its version; executable versions are read from that metadata. Run `pnpm violet-map --version` to inspect the CLI version; every subcommand uses that package version.

[CHANGELOG.md](CHANGELOG.md) records releases and the version policy. `pnpm version:check` validates every package's semantic version and enforces a shared MAJOR, plus a shared MINOR while MAJOR is `0`. Package PATCH versions may differ; after `1.0.0`, MINOR versions may also differ. CI runs this check.

For a coordinated release, run `pnpm version:set <version>` (for example, `pnpm version:set 0.2.0-rc.1`) to update the root and all workspace manifests. To update one package, use its exact metadata name: `pnpm version:set 0.1.1 --package @violet-map/cli`. The `--package` option may also precede the version. Both modes validate the entire proposed workspace against the version policy before writing any files; a targeted update leaves all other manifests unchanged. Add the corresponding changelog entry and run the production checks before publishing; these commands only update or validate local metadata and do not create commits, tags, or publications. Minecraft, cache, and file-format versions advance independently of package versions.

## Assets and local worlds

Extract client assets (only use Minecraft assets you are entitled to use):

```bash
pnpm violet-map assets extract --version 1.21.4 --dir packages/server/data/assets
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

If either variable is omitted, no root account exists. After running the server's `db:migrate`, bootstrap a normal administrator through the business CLI while the PGlite service is stopped:

```bash
pnpm violet-map users create --via database \
  --database-dir "$PWD/packages/server/data/users.pglite" \
  --username alice --role admin
```

The password is read without echo from the terminal. `--password-stdin` or `--password-file <file>` supplies it non-interactively. PostgreSQL operators can select `--via database` with `DATABASE_URL` or a credential reference. These commands perform business operations only: they verify migration history and never generate, baseline, or apply migrations.

For normal online administration, use API mode (the default):

```bash
pnpm violet-map profile set production --server-url https://map.example.com
pnpm violet-map profile use production
pnpm violet-map auth login --username alice
pnpm violet-map auth whoami
pnpm violet-map users list
pnpm violet-map users update --username another_user --role ci
pnpm violet-map users update --username another_user --disable
pnpm violet-map users delete --username another_user
pnpm violet-map credentials issue --username deploy_user --expires-in 3600
pnpm violet-map credentials revoke --username deploy_user
pnpm violet-map auth logout
```

User creation and updates reject `root` and `guest` roles. The Admin UI provides the same user CRUD, enable/disable controls, login, and credential issuance. Login produces a 12-hour bearer credential; issued user credentials last 60 seconds to 365 days. `credentials issue` intentionally prints the raw token once. Ordinary output, configuration inspection, and logs do not print stored secrets. Send API credentials with `Authorization: Bearer <token>`.

`auth logout` revokes the selected token on the server before removing its cached login. An already invalid token is also cleared; a network failure preserves the login for retry. `auth logout --local` removes only the cached login. `credentials revoke --username ...` revokes all credentials belonging to that non-special user, whereas `credentials delete <name>` only removes a local secret. Disabling/deleting a user or changing their password revokes their credentials. Every authenticated request reads the user's current role, so role changes take effect immediately.

The server is authoritative for remote access:

| Operation                                                            | Minimum role |
| -------------------------------------------------------------------- | ------------ |
| Public map reads                                                     | guest        |
| Diagnostics and current identity                                     | viewer       |
| World/storage administration and sync, including deletions           | ci           |
| User administration, issuing/revoking user credentials, biome writes | admin        |
| All API operations                                                   | root         |

Missing, expired, or revoked credentials return HTTP 401. An authenticated user with insufficient permissions receives HTTP 403. Commands report the failure without changing transport or trying another identity. Direct database mode is an explicit trusted operator channel, authorized by database credentials or filesystem permissions, and retains the same user/password/role business validation.

### CLI configuration, profiles, and state

The installed executable is `violet-map`. In this workspace, `pnpm violet-map ...` runs that same command tree from source; no former executable names, `admin` entrypoints, or deprecated flag aliases are provided. Commander validates unknown options, required operands, choices, numeric values, and mutually exclusive options. Root `--version` reports the CLI release; `assets extract --version <id>` selects Minecraft. Common options may be placed before or after subcommands; when explicitly supplied at multiple scopes, the option nearest the executed command takes precedence.

CLI configuration is versioned JSON, separate from the server's deployment YAML. Settings resolve as explicit command options, then environment variables, then the selected profile, then defaults. Profile selection uses `--profile`, `VIOLET_MAP_PROFILE`, then `defaultProfile`. Ordinary commands never persist temporary overrides. Profiles change only through `profile set/use/delete`; `auth login` creates or updates its explicitly selected server profile after a successful login.

```bash
pnpm violet-map config paths
pnpm violet-map config show --sources
pnpm violet-map config set --credential-store file
pnpm violet-map profile list
pnpm violet-map profile set local --database-dir /srv/violet-map/users.pglite
pnpm violet-map profile set production --database-url-ref env:DATABASE_URL
pnpm violet-map profile set archive --s3-bucket violet-worlds --aws-profile maps
```

Example `config.json` (all fields other than `version` and `profiles` are optional):

```json
{
  "version": 1,
  "defaultProfile": "production",
  "profiles": {
    "production": {
      "server": { "url": "https://map.example.com" },
      "database": { "urlRef": "env:DATABASE_URL" }
    },
    "local": { "database": { "dir": "/srv/violet-map/users.pglite" } },
    "archive": { "s3": { "bucket": "violet-worlds", "awsProfile": "maps" } }
  }
}
```

Server URLs are normalized HTTP(S) origins, without a path, query, fragment, or embedded credentials. A saved login is bound to both the profile name and server origin. Selecting another server does not reuse the first server's cached token. An environment token paired with a different environment server URL is rejected when a command overrides that URL.

| Location       | Default                                                       |
| -------------- | ------------------------------------------------------------- |
| macOS config   | `~/Library/Preferences/violet-map/cli/config.json`            |
| macOS state    | `~/Library/Application Support/violet-map/cli/state.json`     |
| macOS cache    | `~/Library/Caches/violet-map/cli`                             |
| Linux config   | `${XDG_CONFIG_HOME:-~/.config}/violet-map/cli/config.json`    |
| Linux state    | `${XDG_STATE_HOME:-~/.local/state}/violet-map/cli/state.json` |
| Linux cache    | `${XDG_CACHE_HOME:-~/.cache}/violet-map/cli`                  |
| Windows config | `%APPDATA%\violet-map\Config\cli\config.json`                 |
| Windows state  | `%LOCALAPPDATA%\violet-map\Data\cli\state.json`               |
| Windows cache  | `%LOCALAPPDATA%\violet-map\Cache\cli`                         |

Downloaded Minecraft assets use `cache/assets`. `state.json` contains login metadata and credential references, never secret values. Normal configuration inspection does not open the system credential store. Files are replaced atomically with exclusive writer locks; locks left after a crash require verifying that the owner has stopped before removing the corresponding `.lock` file. Malformed JSON is reported without overwriting it.

| Override | Environment equivalent | Scope |
| --- | --- | --- |
| `--cli-home <dir>` | `VIOLET_MAP_CLI_HOME` | Put `config.json`, `state.json`, `credentials.json`, and `cache/` under one isolated directory. |
| `--config <file>` | `VIOLET_MAP_CLI_CONFIG` | Replace only the CLI configuration file. |
| `--profile <name>` | `VIOLET_MAP_PROFILE` | Select the connection profile for this invocation. |
| `--server-config <file>` | `VIOLET_MAP_CONFIG` | Select deployment YAML for explicit database mode; unrelated to CLI state location. |

```bash
pnpm violet-map --cli-home /tmp/violet-map-test config paths
VIOLET_MAP_CLI_HOME=/tmp/violet-map-test pnpm violet-map profile list
pnpm violet-map --config ./operator.json --profile production users list
```

Location flags choose where the current invocation reads/writes; they do not change the platform default. Overriding only `--config` does not isolate login state. A different CLI home uses a different system-keychain namespace; the operating system still owns the physical keychain. Neither override moves a real database or world archive. CLI file paths resolve from the invocation directory; paths stored in profiles resolve from the CLI configuration file's directory; server YAML paths resolve from that YAML file's directory.

Database mode requires `--via database` and an explicit target. `--database-dir` selects PGlite even if an unrelated `DATABASE_URL` is present. `--database-url-ref` selects PostgreSQL; these two options conflict. Otherwise database environment settings take precedence over profile settings. With `--server-config`, environment settings and the selected YAML determine the target instead of a profile database target. No missing database is silently migrated. PGlite uses the same directory lock as server startup and maintenance; use API mode while its server is running.

### Credential storage

The default persistent backend is the OS credential store: macOS Keychain, Windows Credential Manager, or Linux Secret Service. The native binding is optional and loaded only for secret operations; Linux requires Secret Service explicitly rather than silently switching to an ephemeral kernel keyring. If unavailable or locked, saving fails with an actionable error. Select `--credential-store file` for one command or `config set --credential-store file` to opt into the plaintext file backend. There is no automatic downgrade. If a replacement is saved but its old backend cannot delete the previous secret, the command reports success with a cleanup warning and retains a local reference that can be removed with `credentials delete` when the backend becomes available.

The file backend stores secrets in the state directory's `credentials.json`, with mode 0600 on Unix or a current-user ACL on Windows. New application directories use mode 0700 on Unix. This provides access control, not encryption. System-keychain entries are scoped by the CLI state location; copying a state file to another CLI home does not grant access to its keychain entries. Login passwords are never saved, and command-line/environment overrides are never copied into persistent storage automatically.

Credential references support only these forms:

| Reference | Resolution |
| --- | --- |
| `env:NAME` | Read a non-empty injected environment variable. |
| `file:PATH` | Read a secret file; profile references resolve relative to the CLI config, command-line references to the invocation directory. |
| `secret:NAME` | Read a named secret from the selected CLI state's credential records. |

```bash
pnpm violet-map credentials set database-production --file /run/secrets/database-url
pnpm violet-map profile set production --database-url-ref secret:database-production
pnpm violet-map credentials list
pnpm violet-map credentials delete database-production
pnpm violet-map users list --via database --database-url-ref file:/run/secrets/database-url
```

`credentials set <name> --stdin` also accepts piped secret input. Configuration rejects inline token/password/connection-string fields; use a reference for the entire sensitive database URL. Avoid secrets in argv or checked-in files. CI can inject `VIOLET_SERVER_URL`/`VIOLET_SERVER_TOKEN` directly, or use `--server-token-ref env:NAME|file:PATH|secret:NAME`. Command-line token references override environment tokens; environment tokens override a matching cached login. Explicitly missing credentials fail without falling back. Use HTTPS for remote servers.

S3 uses the AWS SDK's default provider chain when no provider is selected, including AWS environment variables, shared configuration, SSO, and workload roles. `--aws-profile <name>` selects a named SDK profile. Custom S3 credentials can be supplied using `--s3-credentials-ref` or profile `s3.credentialsRef`, containing JSON with `accessKeyId`, `secretAccessKey`, and an optional `sessionToken`. An explicit provider overrides environment/profile providers; environment providers override profile providers. `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` must be supplied together, with optional `S3_SESSION_TOKEN`. Temporary credentials and refreshable providers are supported without copying AWS credentials into CLI configuration.

### Optional server library

API administration and map tools require only the CLI and core runtime dependencies. Database mode dynamically loads the optional peer `@violet-map/server`; install it in the same dependency environment as the CLI when direct access is needed. This workspace supplies it as a development dependency. `@violet-map/server/admin` exports `readAdminConfig` and `createAdminContext`, providing user CRUD and credential issuance/revocation with explicit connection ownership and `close()`. Importing it does not read deployment configuration, start HTTP, or open a database. SQL, schema checks, password processing, and user logic remain owned by server; map/storage algorithms remain owned by core.

Published/default package exports use built JavaScript. Workspace source launchers and tests use the `development` export condition. Build core, server, and CLI before using relocated production artifacts. Database maintenance is available only through the existing server scripts below, not the `violet-map` command tree or the admin library exports.

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
pnpm violet-map world sync \
  --from /backups/my-world --world survival --target local \
  --target-dir /srv/violet-map/worlds --delete

# Local archive -> S3-compatible storage, using an SDK profile or injected credentials
pnpm violet-map world sync \
  --from /backups/my-world --world survival --target s3 \
  --s3-endpoint https://s3.example.com --s3-bucket violet-worlds --s3-prefix production --aws-profile maps

# Local archive -> remote server, sharing the saved production login
pnpm violet-map world sync \
  --from /backups/my-world --world survival --target server \
  --profile production
```

`--dry-run` prints changes without writing. `--delete` mirrors deletions from source to target. `--force` is intentionally separate and should only be used after confirming the target is the same world. Sync hashes same-size files before skipping them, so it works across local filesystems, S3 etags, and server storage consistently.

The server exposes its shared storage adapter under protected `/api/admin/storage/*` endpoints. This is what makes remote CLI sync work, while regular Admin uploads and world edits use the same adapter directly.

## CI/CD

`.github/workflows/ci.yml` installs immutable dependencies, runs lint, formatting, type checks, and focused Node tests, then builds all packages on pushes and pull requests. The tests cover storage consistency, map processing, CLI parsing/configuration/secrets, API authorization, shared world-sync logins, and direct management on PGlite/PostgreSQL. Relocated CLI tests run built JavaScript without server, TypeScript sources, tsx, or a native keyring, then exercise optional direct access after adding server.

`.github/workflows/world-sync.yml` is manually dispatched. Configure repository secrets for either destination:

- Server: `VIOLET_SERVER_URL`, `VIOLET_SERVER_TOKEN`
- S3: `S3_BUCKET`, `S3_ENDPOINT` (optional), `S3_REGION`, `S3_PREFIX` (optional), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_SESSION_TOKEN` (optional)

The workflow accepts the checked-in archive directory, target world name, destination type, and explicit `delete`/`force` switches. Use an issued CI credential with the least privilege necessary.

## Server configuration

CLI profiles and state are described above. Server deployment settings remain independent. Non-sensitive values can be set as environment variables or in `violet-map.yaml` / `violet-map.yml`; use `VIOLET_MAP_CONFIG` to select another file. The file supports standard nested YAML maps and lists. A malformed file stops startup with its path in the error; environment variables take precedence. Relative paths in YAML resolve from the YAML file's directory; paths in environment variables resolve from the process working directory.

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
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_SESSION_TOKEN` | — | S3 credential pair and optional temporary session token; otherwise use the SDK provider chain. |
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
pnpm violet-map --help
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
| `world sync …` | Sync a local archive to local/S3/server storage with identity protection and shared remote authorization. |
| `users list/create/update/delete` | Manage users via API (default) or explicit database mode. |
| `auth login/whoami/logout` | Save, inspect, or revoke a server login. |
| `profile set/list/use/delete` | Manage named connections. |
| `config paths/show/set` | Inspect locations/settings or choose a credential backend. |
| `credentials set/list/delete/issue/revoke` | Manage local secret references and server-issued credentials. |

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
