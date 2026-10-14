# Independent production deployment

[Back to README](../README.md)

Builds use the workspace. Running services need only their own artifacts. Server does not serve or depend on either frontend; web/admin can point to an external API and start while it is unavailable.

## Node artifacts

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @violet-map/server deploy --legacy --prod /srv/violet-api
```

`deploy --legacy` selects pnpm's deploy implementation without injected workspace dependencies. The deployed directory contains package metadata, `dist`, bundled resources/migrations, core/storage and production dependencies. It has no application sources, render/web/admin, tsx or TypeScript. Move this entire directory, including its internal `node_modules` links, together. Runtime requires Node.js 24+ and is independent of the repository or working directory:

```bash
cd /srv/violet-api
DEPLOYMENT_PROFILE=public DATA_DIR=/srv/violet-data \
  WORLDS_DIR=/srv/violet-data/worlds ASSETS_DIRS=/srv/violet-data/assets \
  node dist/src/index.js
```

For `sync`, add `STATIC_API_TOKEN` from the environment. For `full`, supply the database target and run `node dist/src/db/maintenance.js migrate` before starting; migrations never run on startup. Bundled defaults and migrations resolve relative to module URLs; world, asset and writable data directories resolve through configuration.

Deliver `packages/web/dist` and `packages/admin/dist` independently. They have no runtime npm dependencies. Any static host can serve them, or use the bundled Node server:

```bash
API_BASE_URL=https://api.example.com/violet/ node /srv/violet-web/serve.mjs 3305
API_BASE_URL=https://api.example.com/violet/ node /srv/violet-admin/serve.mjs 3310
```

`API_BASE_URL` writes runtime config on startup, requiring a writable artifact directory. On read-only static hosting, replace `runtime-config.json` during deployment instead. Serve that file and `index.html` with `no-store`; hashed JS/CSS can use immutable caching. Runtime JSON has `apiBaseUrl` and optional `capabilityFallback` (`legacy` or `error`), never credentials. Only a runtime-config 404 permits the build fallback; capabilities fallback requires its own explicit 404. Connection errors show a Retry action.

Workspace `pnpm start` and `start:full` pass `http://localhost:3300/` as the default API for their static frontend processes. Set `API_BASE_URL` to override it. Direct static hosting retains the runtime file/origin behavior above.

For frontend subpaths, build each base separately:

```bash
VITE_BASE_PATH=/map/ pnpm --filter @violet-map/web build
VITE_BASE_PATH=/console/ pnpm --filter @violet-map/admin build
STATIC_BASE_PATH=/map/ API_BASE_URL=https://api.example.com/violet/ node packages/web/dist/serve.mjs 3305
STATIC_BASE_PATH=/console/ API_BASE_URL=https://api.example.com/violet/ node packages/admin/dist/serve.mjs 3310
```

The built static base and hosting base must agree. API prefixes are independent: the reverse proxy forwards `/violet/api/...` as `/api/...`. No rebuild is needed to replace the API address. Tokens are saved by normalized API base, including its prefix, and old unbound tokens require explicit reentry. Configure `CORS_ORIGINS` with the frontend origins; methods, Bearer preflight and exposed ETag/Range/retry headers are provided by server. Fetch does not use cookies.

## Containers

`compose.yaml` remains a source-mounted development setup. Production uses `Dockerfile.server`, `Dockerfile.web`, `Dockerfile.admin` and `compose.production.yaml`:

```bash
docker compose -f compose.production.yaml up --build -d server web admin
# Or start only a frontend against an already deployed API:
API_BASE_URL=https://api.example.com/violet/ docker compose -f compose.production.yaml up --build -d web
```

No production service has `depends_on`. Server defaults explicitly to `public`, with a writable named `/data` volume. The frontend images contain only static output and Node's static server; the API image contains the deployed server production artifact. Runtime stages use the `node` user and do not install workspace tools. Build context excludes worlds, user databases, extracted assets, node_modules, dist, temporary files and Git history. Supply your own data/asset mounts and secret environment when deploying.

For a full user deployment, stop the API, set `DEPLOYMENT_PROFILE=full`, and run maintenance using the same volume/env as server:

```bash
DEPLOYMENT_PROFILE=full docker compose -f compose.production.yaml run --rm server node dist/src/db/maintenance.js migrate
DEPLOYMENT_PROFILE=full docker compose -f compose.production.yaml up -d server
```

Pass root or PostgreSQL settings explicitly as appropriate. Maintenance is independent of HTTP features and uses no admin Bearer token. PGlite requires the API to be stopped while using its directory. Public/sync do not create or inspect a user database even if database/root environment values exist.

For static prefixes with Docker, build with `--build-arg VITE_BASE_PATH=/map/` (or `/console/`) and run with the matching `STATIC_BASE_PATH`. `API_BASE_URL` must be reachable from the browser; a container-only service hostname is unsuitable.

## Acceptance

After building, run `pnpm boundary:check`, `pnpm test:production`, `pnpm --filter @violet-map/cli test:artifact`, `pnpm --filter @violet-map/server test:db:artifact` and `pnpm test:frontend`. The browser test needs Playwright Chromium (`pnpm exec playwright install chromium`); on macOS it defaults to installed Google Chrome, override with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. CI builds `/map/` and `/console/` and verifies three origins, the `/violet/` API prefix, CORS Canvas/WebGL, Bearer uploads/Range and token isolation.

With a local Docker engine, `pnpm test:containers` builds the three production images and tests independent frontend startup plus public/sync/full server containers.
