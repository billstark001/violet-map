# Server configuration

Resource delivery uses the coordinated 0.4 protocol. See [Unified resources](resources.md) for role, zero-retention, optional persistence, publication and migration contracts.

[Back to README](../README.md)

CLI profiles and state are described in [CLI configuration and credentials](cli-configuration.md). Server deployment settings remain independent. Non-sensitive values can be set as environment variables or in `violet-map.yaml` / `violet-map.yml`; use `VIOLET_MAP_CONFIG` to select another file. The file supports standard nested YAML maps and lists. A malformed file stops startup with its path in the error; environment variables take precedence. Relative paths in YAML resolve from the YAML file's directory; paths in environment variables resolve from the process working directory.

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

Secrets (`DATABASE_URL`, root password, S3 secrets, `STATIC_API_TOKEN`) are ENV-only. YAML attempts to provide them are rejected. Root username also remains ENV-only. Unknown YAML names/types and conflicting old/new fields fail startup; errors do not print secret values. Configuration is read once by bootstrap and passed to application/service factories.

## Profiles and capabilities

Settings resolve ENV > YAML > profile > defaults. Explicit `configFile` takes precedence over `VIOLET_MAP_CONFIG`; otherwise cwd is searched for `violet-map.yaml`, then `.yml`. Missing default files are allowed; explicit missing files and malformed YAML fail. Paths supplied in YAML use its directory, ENV paths use cwd, bundled resources use module URLs.

| `deployment.profile` / `DEPLOYMENT_PROFILE` | adminApi | users | worldWrites | dataWrites | diagnostics | Auth   |
| ------------------------------------------- | -------- | ----- | ----------- | ---------- | ----------- | ------ |
| public                                      | false    | false | false       | false      | false       | none   |
| sync                                        | true     | false | true        | false      | false       | static |
| full (default)                              | true     | true  | true        | true       | true        | users  |

`public` and `sync` never initialize, migrate, inspect or create a user DB, irrespective of configured database/root settings. Full retains existing login/revocation/role behavior and requires prior explicit migration. Process-group scripts `dev:light/full` and `start:light/full` do not select a server capability profile.

| YAML | Environment | Meaning |
| --- | --- | --- |
| features.adminApi | ADMIN_API_ENABLED | All management read/write/user interfaces, including routes outside `/api/admin`. |
| features.users | USERS_ENABLED | User/credential DB, login/identity/logout. |
| features.worldWrites | WORLD_WRITES_ENABLED | Create/delete/upload/raw storage writes and sync writes. |
| features.dataWrites | DATA_WRITES_ENABLED | Biome writes and asset reload. |
| features.diagnostics | DIAGNOSTICS_ENABLED | Protected diagnostic uploads, independent of adminApi. |
| auth.mode | AUTH_MODE | none, static, users. |
| auth.staticRole | STATIC_TOKEN_ROLE | viewer, ci or admin; defaults to ci. |
| — | STATIC_API_TOKEN | Required ENV-only secret for static mode. |
| server.cors.origins | CORS_ORIGINS | YAML list or ENV comma-separated browser origins; default `*`. |

Disabling adminApi forces effective worldWrites/dataWrites off; capabilities report the effective values. User management requires both users and adminApi, while login/identity/logout require only users. All disabled endpoints return 404 before auth, enabled protected routes keep 401/403. Maps remain public and read-only batch POSTs/atlas builds stay available in public mode.

Auth defaults to users when users is enabled, static when users is disabled under sync, otherwise none. Explicit users mode requires users enabled; none/static require users disabled. Any effective admin or diagnostic capability requires usable auth. To disable users under full while retaining admin, explicitly choose static and supply its token. Static uses constant-time credential comparison, the existing role policy, and no login, issuance or persistence.

## Normalized fields and retained external settings

| Old YAML field | Normalized YAML field | Existing ENV    |
| -------------- | --------------------- | --------------- |
| port           | server.port           | PORT            |
| worldsDir      | worlds.dir            | WORLDS_DIR      |
| worldStorage   | storage.driver        | WORLD_STORAGE   |
| assetsDirs     | assets.dirs           | ASSETS_DIRS     |
| dataDir        | data.dir              | DATA_DIR        |
| databaseDir    | database.dir          | DATABASE_DIR    |
| mcVersion      | minecraft.version     | MC_VERSION      |
| mcDataVersion  | minecraft.dataVersion | MC_DATA_VERSION |

These documented external settings remain supported; they are not ServerConfig code aliases. Two names supplied by the same YAML file must agree even if ENV overrides them. Booleans must be YAML booleans or ENV true/false/1/0. Numbers must be safe integers in their allowed range; empty strings, fractions and malformed values are rejected. Port is 1–65535. Zero disables cache capacity/TTL or queuing where listed below; active-work limits and request byte limits must be positive.

| YAML                     | Environment                  | Default      |
| ------------------------ | ---------------------------- | ------------ |
| cache.storageStatMs      | STORAGE_STAT_CACHE_MS        | 1000         |
| cache.storageListMs      | STORAGE_LIST_CACHE_MS        | 2000         |
| limits.mediaImports      | MEDIA_IMPORT_CONCURRENCY     | 1 (1–1024)   |
| limits.mediaQueue        | MEDIA_IMPORT_QUEUE           | 8 (0–65536)  |
| limits.contentMutations  | CONTENT_MUTATION_CONCURRENCY | 1 (1–1024)   |
| limits.contentQueue      | CONTENT_MUTATION_QUEUE       | 32 (0–65536) |
| limits.chunkRequestBytes | CHUNK_REQUEST_BYTES          | 65536        |
| limits.atlasRequestBytes | ATLAS_REQUEST_BYTES          | 131072       |
| limits.diagnosticBytes   | DIAGNOSTIC_BYTES             | 2097152      |
| limits.uploadBytes       | UPLOAD_BYTES                 | 268435456    |

Media import capacity is reserved before reading request bytes, decoding images/GLB or publishing blobs. Queued requests retain their unread stream rather than a full buffered upload; an exhausted queue returns 503 `CONTENT_BUSY` with `Retry-After: 1`. The upload byte limit remains per request, so choose active concurrency for the available memory.

Metadata mutations (maps, layer documents, bindings and media deletion) have a separate capacity budget. They reserve a slot before reading JSON; queued requests keep their bodies unread and excess requests return the same retryable `CONTENT_BUSY` response. This bounds HTTP buffering, while the content service still serializes metadata publication within its single writer. Increasing HTTP concurrency does not introduce parallel metadata commits.

Online body retention is configured only through `resources.cache`; active generation and task admission use `resources.work.memoryBytes` and `resources.work.maxTasks` (ENV `RESOURCES_WORK_MAX_TASKS`, default 16). Server factories explicitly disable long-lived source region/NBT/texture/world-list caches. Top-map verification retains at most 32 MiB of regions during a single generation operation, within its work budget. Independent source tools configure their typed cache options directly. Removed source cache byte/TTL settings and chunk/atlas concurrency/queue settings fail startup rather than being accepted and ignored.

`cache.storageStatMs` and `cache.storageListMs` apply only to non-authoritative mounted storage metadata. World mutation mounts and publication/cache authority mounts always bypass these TTLs.

Cache and byte limits are bounded by safe integers. Protocol constants such as batch sizes remain in code. Limits/caches belong to instances, so applications in the same process do not share state.

Public deployment example:

```yaml
deployment:
  profile: public
server:
  port: 3300
  cors:
    origins: [https://map.example.com, https://console.example.com]
storage:
  driver: local
worlds:
  dir: /srv/violet-map/worlds
assets:
  dirs: [/srv/violet-map/assets]
data:
  dir: /srv/violet-map/data
```

For sync use `deployment.profile: sync` and supply `STATIC_API_TOKEN` in ENV. For independent artifacts, static runtime config, containers and database maintenance, see [deployment](deployment.md).

See [external overlays and named storage mounts](overlays.md) for the object storage, content API, CLI, configuration and persistence contract.
