# Violet Map

Violet Map is a browser-first Minecraft Java world explorer. It combines a Hono API, a Three.js viewer, offline asset/top-map tooling, and an optional admin console. It reads standard Java region layouts (`region`, `DIM-1`, `DIM1`, and modern `dimensions/…`) without requiring the Minecraft client to run.

## Quick start

Requires Node.js 24+ and pnpm 12.

```bash
pnpm install
pnpm --filter @violet-map/server... build
pnpm --filter @violet-map/server db:migrate
pnpm dev:full
```

| Service | URL                     |
| ------- | ----------------------- |
| API     | <http://localhost:3300> |
| Viewer  | <http://localhost:3305> |
| Admin   | <http://localhost:3310> |

`pnpm dev` and `pnpm start` run the server plus viewer. Use `pnpm dev:full` / `pnpm start:full` when the admin UI is also needed.

Docker equivalents are `docker compose --profile light up` and `docker compose --profile full up`. Follow the [database operations guide](docs/database.md#database-operations) to initialize or upgrade the database manually before starting these services; Compose does not run migrations.

## Documentation

| Guide | Topics |
| --- | --- |
| [Viewer, assets, and local worlds](docs/viewer-and-assets.md) | Asset extraction, world layout, viewer settings, CLI tools, resource renderers, and limits. |
| [Authentication and users](docs/authentication.md) | Roles, administrator bootstrap, login, user management, and API permissions. |
| [CLI configuration and credentials](docs/cli-configuration.md) | Profiles, settings, state locations, credential storage, and secret references. |
| [Database administration](docs/database.md) | Database drivers, migrations, maintenance, and the optional server library. |
| [World storage and synchronization](docs/world-storage.md) | Local, S3, and server storage; archive identity checks and sync commands. |
| [Server configuration](docs/server-configuration.md) | Deployment YAML, environment variables, and defaults. |
| [Independent deployment](docs/deployment.md) | Production artifacts, Docker services, static API configuration and subpaths. |
| [Development and releases](docs/development.md) | Workspace packages, validation, version policy, and CI/CD. |

The default server profile is `full`; `light`/`full` scripts select local processes. For a public map without a user database, use `DEPLOYMENT_PROFILE=public`. After `pnpm build`, server runs built Node ESM and web/admin serve their static artifacts without Vite. Production services can run independently; see [deployment](docs/deployment.md).
