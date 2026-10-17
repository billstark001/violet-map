# Development and releases

[Back to README](../README.md)

## Packages

| Package | Purpose |
| --- | --- |
| `@violet-map/core` | Neutral world data, NBT/region codecs, top-map formats, HTTP contracts, storage interfaces and concurrency utilities. |
| `@violet-map/render` | CPU models, lighting, colors, meshes, top-map sampling/geometry and camera ranking; depends only on core. |
| `@violet-map/storage` | Local/S3/HTTP adapters, caching, prefixes and synchronization; depends only on core. |
| `@violet-map/cli` | The `violet-map` CLI: assets, maps, profiles, credentials, and API/direct user administration. |
| `@violet-map/server` | Hono API, world service, database/user services, and a side-effect-free optional `server/admin` library. |
| `@violet-map/web` | Three.js world viewer with worker meshing and an optional IndexedDB mesh cache. |
| `@violet-map/admin` | Admin UI for worlds, uploads, biome data, users, and temporary credentials. |

## Validation

Oxlint loads the maintained `@stylistic/padding-line-between-statements` rule through its JS plugin support. Top-level functions (including assigned arrow functions), classes and module sections require a blank line. Consecutive imports, reexports and ordinary variable declarations may remain grouped; function bodies are unaffected. Run `pnpm exec oxlint --fix packages`, then `pnpm format` to apply spacing and formatting together. `pnpm lint` checks this in CI, and a fixture test verifies both the required and exempt cases.

```bash
pnpm typecheck
pnpm version:check
pnpm boundary:check
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm --filter @violet-map/cli test:artifact
pnpm --filter @violet-map/server test:db:artifact
pnpm test:production
pnpm test:release
pnpm test:containers
# Browser acceptance also supports /map/ and /console/ builds.
pnpm exec playwright install chromium
pnpm test:frontend
pnpm test:overlays
```

To exercise the real OS credential store on a machine with an unlocked keychain, run `pnpm --filter @violet-map/cli test:keychain` explicitly. This integration test uses a temporary CLI home and its isolated random keychain namespace, checks native write/read/update/delete and the application's replacement lifecycle, and verifies cleanup of every test entry and the temporary directory. It never reads or changes existing CLI credentials. It is excluded from `pnpm test` and CI because those environments may not have an accessible credential store.

## Versions and changelog

The root workspace and all seven packages currently share the `0.2.0` development release line. Each package's `package.json` is the source of truth for its version; executable versions are read from that metadata. Run `pnpm violet-map --version` to inspect the CLI version; every subcommand uses that package version.

[CHANGELOG.md](../CHANGELOG.md) records releases and the version policy. `pnpm version:check` validates every package's semantic version and enforces a shared MAJOR, plus a shared MINOR while MAJOR is `0`. Package PATCH versions may differ; after `1.0.0`, MINOR versions may also differ. CI runs this check.

For a coordinated release, run `pnpm version:set <version>` (for example, `pnpm version:set 0.2.0-rc.1`) to update the root and all workspace manifests. To update one package, use its exact metadata name: `pnpm version:set 0.1.1 --package @violet-map/cli`. The `--package` option may also precede the version. Both modes validate the entire proposed workspace against the version policy before writing any files; a targeted update leaves all other manifests unchanged. Add the corresponding changelog entry and run the production checks before publishing; these commands only update or validate local metadata and do not create commits, tags, or publications. Minecraft, cache, and file-format versions advance independently of package versions.

## CI/CD

`.github/workflows/ci.yml` installs immutable dependencies, runs lint, formatting, type checks, and focused Node tests, then builds all packages on pushes and pull requests. The tests cover storage consistency, map processing, CLI parsing/configuration/secrets, API authorization, shared world-sync logins, and direct management on PGlite/PostgreSQL. Relocated CLI tests run built JavaScript without server, TypeScript sources, tsx, or a native keyring, then exercise optional direct access after adding server.

`.github/workflows/world-sync.yml` is manually dispatched. Configure repository secrets for either destination:

- Server: `VIOLET_SERVER_URL`, `VIOLET_SERVER_TOKEN`
- S3: `S3_BUCKET`, `S3_ENDPOINT` (optional), `S3_REGION`, `S3_PREFIX` (optional), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_SESSION_TOKEN` (optional)

The workflow accepts the checked-in archive directory, target world name, destination type, and explicit `delete`/`force` switches. Use an issued CI credential with the least privilege necessary.

Production artifacts and independent Docker services are described in [deployment](deployment.md). CI also runs AST package-boundary checks, relocated production server tests, package publication checks and three-origin browser acceptance with static/API prefixes.

The overlay release gate, isolated S3 option, measured resource budgets and paired binary/config rollback are described in [overlay release acceptance](overlay-release-acceptance.md). `test:release` builds the pre-overlay Git revision to exercise actual old binaries and uses temporary directories. `VIOLET_ACCEPTANCE_ENV_FILE` opts into an existing S3/R2 bucket under a random isolated prefix; no extra hosted service is required. Without it only that S3 case is skipped. Use local PostgreSQL with `TEST_DATABASE_URL` to include all database cases.

For native browser mesh-cache measurements, run `pnpm exec tsx scripts/bench/mesh-cache.ts 500`. It starts an isolated Vite/browser session and compares cold IndexedDB clones against warm immutable-buffer reuse at 4 KiB, 256 KiB and 4 MiB. The optional argument is the measured rounds per case (1–10000); each case has ten warmup rounds. Browser timer resolution may round very short warm reads to zero. Use the reported browser, payload size and percentiles when comparing results; this measures cache access rather than overall frame time.

For server decompression measurements, run `pnpm exec tsx scripts/bench/chunk-decode.ts /path/to/r.0.0.mca /path/to/r.-1.-1.mca`. Supply one or two regions; the benchmark selects each region's eight largest compressed records, verifies byte-for-byte codec agreement, and compares portable pako, native synchronous zlib and native asynchronous zlib over twenty batches. It reports batch latency and timer delay, including the exact-size output copy used by the server. Only the supplied files are read, and no world data is copied into the repository. On the local village sample with Node 26.8.1, sixteen chunks took about 5.1 ms per batch with pako and 2.6 ms asynchronously; timer delay dropped from about 5.7 ms to 1.3 ms. These numbers describe decompression, not complete request latency, and depend on the host and chosen records.
