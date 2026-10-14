# Development and releases

[Back to README](../README.md)

## Packages

| Package | Purpose |
| --- | --- |
| `@violet-map/core` | NBT, regions, lighting, meshing, top-map code, plus the shared local/S3/server `WorldStorage` adapters. |
| `@violet-map/cli` | The `violet-map` CLI: assets, maps, profiles, credentials, and API/direct user administration. |
| `@violet-map/server` | Hono API, world service, database/user services, and a side-effect-free optional `server/admin` library. |
| `@violet-map/web` | Three.js world viewer with worker meshing and an optional IndexedDB mesh cache. |
| `@violet-map/admin` | Admin UI for worlds, uploads, biome data, users, and temporary credentials. |

## Validation

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

## Versions and changelog

The root workspace and all five packages start at `0.1.0`. Each package's `package.json` is the source of truth for its version; executable versions are read from that metadata. Run `pnpm violet-map --version` to inspect the CLI version; every subcommand uses that package version.

[CHANGELOG.md](../CHANGELOG.md) records releases and the version policy. `pnpm version:check` validates every package's semantic version and enforces a shared MAJOR, plus a shared MINOR while MAJOR is `0`. Package PATCH versions may differ; after `1.0.0`, MINOR versions may also differ. CI runs this check.

For a coordinated release, run `pnpm version:set <version>` (for example, `pnpm version:set 0.2.0-rc.1`) to update the root and all workspace manifests. To update one package, use its exact metadata name: `pnpm version:set 0.1.1 --package @violet-map/cli`. The `--package` option may also precede the version. Both modes validate the entire proposed workspace against the version policy before writing any files; a targeted update leaves all other manifests unchanged. Add the corresponding changelog entry and run the production checks before publishing; these commands only update or validate local metadata and do not create commits, tags, or publications. Minecraft, cache, and file-format versions advance independently of package versions.

## CI/CD

`.github/workflows/ci.yml` installs immutable dependencies, runs lint, formatting, type checks, and focused Node tests, then builds all packages on pushes and pull requests. The tests cover storage consistency, map processing, CLI parsing/configuration/secrets, API authorization, shared world-sync logins, and direct management on PGlite/PostgreSQL. Relocated CLI tests run built JavaScript without server, TypeScript sources, tsx, or a native keyring, then exercise optional direct access after adding server.

`.github/workflows/world-sync.yml` is manually dispatched. Configure repository secrets for either destination:

- Server: `VIOLET_SERVER_URL`, `VIOLET_SERVER_TOKEN`
- S3: `S3_BUCKET`, `S3_ENDPOINT` (optional), `S3_REGION`, `S3_PREFIX` (optional), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_SESSION_TOKEN` (optional)

The workflow accepts the checked-in archive directory, target world name, destination type, and explicit `delete`/`force` switches. Use an issued CI credential with the least privilege necessary.
