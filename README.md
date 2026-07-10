# Violet Map

Violet Map is a browser-first Minecraft Java world explorer. It combines a Hono API, a Three.js viewer, offline asset/top-map tooling, and an optional admin console. It reads standard Java region layouts (`region`, `DIM-1`, `DIM1`, and modern `dimensions/…`) without requiring the Minecraft client to run.

## Packages

| Package | Purpose |
| --- | --- |
| `@violet-map/core` | NBT, regions, lighting, meshing, top-map code, plus the shared local/S3/server `WorldStorage` adapters. |
| `@violet-map/assets` | CLI for vanilla assets, top-map baking, profiling, and verified world-file synchronization. |
| `@violet-map/server` | Hono API, world service, storage-backed administration, and the Drizzle user database. |
| `@violet-map/web` | Three.js world viewer with worker meshing and an optional IndexedDB mesh cache. |
| `@violet-map/admin` | Admin UI for worlds, uploads, biome data, users, and temporary credentials. |

## Quick start

Requires Node.js 20+ and pnpm.

```bash
pnpm install
pnpm dev:full
```

| Service | URL |
| --- | --- |
| API | <http://localhost:3300> |
| Viewer | <http://localhost:3305> |
| Admin | <http://localhost:3310> |

`pnpm dev` and `pnpm start` run the server plus viewer. Use `pnpm dev:full` / `pnpm start:full` when the admin UI is also needed. Production checks are:

```bash
pnpm typecheck
pnpm build
```

Docker equivalents are `docker compose --profile light up` and `docker compose --profile full up`.

## Assets and local worlds

Extract client assets (only use Minecraft assets you are entitled to use):

```bash
pnpm --filter @violet-map/assets dev assets extract --version 1.21.4 --dir packages/server/data/assets
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

Both drivers use the same Drizzle schema and create their tables/indexes at startup:

- Default: persistent PGlite at `DATA_DIR/users.pglite`.
- PostgreSQL: set `DATABASE_URL` (for example `postgres://user:password@host:5432/violet_map`).

Set `DATABASE_DIR` to override the PGlite path. `DATABASE_URL` takes precedence. Never commit either database directory or a connection string containing a password.

## World storage and safe synchronization

`WorldStorage` lives in `@violet-map/core/storage` and has three interchangeable adapters:

1. `local` — a filesystem root.
2. `s3` — AWS S3 or S3-compatible object storage.
3. `server` — a remote Violet Map server through authenticated storage APIs.

The server selects `local` or `s3` with `WORLD_STORAGE`. The assets CLI syncs a **local world archive** to any of the three. It creates `.violet-map/identity.json` in the source archive and checks it against the target before writing. A different or missing marker on a non-empty target emits a warning and aborts unless `--force` is explicitly supplied.

```bash
# Local archive -> another filesystem worlds root
pnpm --filter @violet-map/assets dev world sync \
  --from /backups/my-world --world survival --target local \
  --target-dir /srv/violet-map/worlds --delete

# Local archive -> S3-compatible storage (credentials may also come from S3_* env vars)
pnpm --filter @violet-map/assets dev world sync \
  --from /backups/my-world --world survival --target s3 \
  --s3-endpoint https://s3.example.com --s3-bucket violet-worlds --s3-prefix production

# Local archive -> remote Violet Map server, using a CI/admin/root credential
pnpm --filter @violet-map/assets dev world sync \
  --from /backups/my-world --world survival --target server \
  --server-url https://map.example.com --server-token "$VIOLET_SERVER_TOKEN"
```

`--dry-run` prints changes without writing. `--delete` mirrors deletions from source to target. `--force` is intentionally separate and should only be used after confirming the target is the same world. Sync hashes same-size files before skipping them, so it works across local filesystems, S3 etags, and server storage consistently.

The server exposes its shared storage adapter under protected `/api/admin/storage/*` endpoints. This is what makes remote CLI sync work, while regular Admin uploads and world edits use the same adapter directly.

## CI/CD

`.github/workflows/ci.yml` installs immutable dependencies, runs the workspace typecheck, and builds all packages on pushes and pull requests.

`.github/workflows/world-sync.yml` is manually dispatched. Configure repository secrets for either destination:

- Server: `VIOLET_SERVER_URL`, `VIOLET_SERVER_TOKEN`
- S3: `S3_BUCKET`, `S3_ENDPOINT` (optional), `S3_REGION`, `S3_PREFIX` (optional), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`

The workflow accepts the checked-in archive directory, target world name, destination type, and explicit `delete`/`force` switches. Use an issued CI credential with the least privilege necessary.

## Configuration

Non-sensitive values can be set as environment variables or in `violet-map.yaml` / `violet-map.yml`; use `VIOLET_MAP_CONFIG` to select another file.

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
| `ASSETS_DIRS` | `data/assets` | Comma-separated resource pack directories. |
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
pnpm --filter @violet-map/assets dev --help
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

## Limits

- Rendering targets modern (1.18+) `sections` / `block_states` chunk layouts.
- Entities and block entities are not rendered.
- Biome tinting is sampled per block; radius blending is not implemented.
- Fluid surfaces approximate vanilla flow and are not animated.
