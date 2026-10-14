# Changelog

All notable changes to Violet Map are documented in this file. Entries follow the categories used by Keep a Changelog and use semantic version numbers.

## Version policy

- Versions use `MAJOR.MINOR.PATCH`; release candidates may append `-rc.N`.
- All workspace packages must share the same MAJOR version.
- While MAJOR is `0`, all packages must also share the same MINOR version. A new development release line therefore updates every package's MAJOR.MINOR.
- PATCH versions may be equal for a coordinated release, or differ when only one package or a narrow group changes. Unaffected packages do not need a patch bump. For example, CLI `0.3.1` may coexist with core, server, web, admin, and root workspace metadata at `0.3.0`; CLI `0.4.0` may not.
- Once MAJOR is stable (at least `1`), package MINOR and PATCH versions may advance independently. Incompatible public API changes require a coordinated MAJOR increase; compatible functionality increases MINOR, and compatible fixes increase PATCH.
- Before `1.0.0`, compatibility is not guaranteed. Prefer a shared MINOR bump for incompatible changes. A targeted security correction may ship as a package PATCH, but its compatibility impact and migration must be explicit.
- A component's package metadata, default executable version, and default client user-agent version must agree where those representations exist. Release build metadata must identify the component version being released; the root package version identifies the shared workspace line, not every independently patched component.
- Published versions are immutable: do not reuse the same package version for different released code. Multiple development commits may retain a version before publication; record changes after a release under Unreleased until assigning their next version.

## Entry and date conventions

- Use `## [MAJOR.MINOR.PATCH] - YYYY-MM-DD` for a shared release line.
- Use `## @violet-map/package [MAJOR.MINOR.PATCH] - YYYY-MM-DD` for a package-specific release, using its exact package name.
- Keep Unreleased first, followed by entries in reverse chronological order. A package-specific entry does not imply that every package has that version.
- For a tagged release, use its publication date; for an untagged historical version, use the version-bump commit's committer date. The initial consolidated development baseline uses the date it is documented. These historical version entries do not assert that an untagged version was published.

---

## [Unreleased]

### Added

- Independent render/storage packages, core contracts/formats/default data, AST dependency checks and isolated CLI capability loading.
- Server configuration/service/application factories, public/sync/full capability presets and static Bearer authentication without a user database.
- Frontend runtime API configuration, API/static prefixes, CORS resources and credentials bound to the API URL.
- Built standalone server artifacts, three production Dockerfiles, production Compose, publication checks and three-origin browser acceptance.

- Named CLI profiles, platform configuration/state/cache paths, `--cli-home` and explicit configuration-file overrides, with setting-source inspection.
- Shared server login, identity, logout/revocation, and credential references for API administration and remote world synchronization. Secrets use an optional OS credential-store binding or an explicitly selected private file backend; CI can inject environment variables or files.
- A side-effect-free optional `@violet-map/server/admin` library for direct user/credential operations on already-migrated PGlite or PostgreSQL databases. Database generation/status/migration/baseline remain exclusively in the server deployment tooling.
- PGlite/PostgreSQL management and authorization integration tests, saved-login/world-sync tests, configuration and credential tests, and relocated CLI artifact checks without server, TypeScript execution, or native credential storage.
- An explicit real-system credential-store integration test covering write/read/update/delete, application credential replacement, and verified cleanup in an isolated temporary namespace.

### Changed

- Core mesher/model/colors/light/storage implementations and server/contracts exports are removed; import algorithms from render, adapters from storage, and shared HTTP DTOs from core/contracts. No transitional compatibility exports or legacy symbol aliases are provided. CLI requires only core and declares render/storage/server as optional peers. Existing HTTP paths, data schemas, sync identity checks, authentication and documented deployment settings remain supported.

- The sole CLI executable is `violet-map`, using Commander for every command; user administration now belongs to the CLI package. Former executable names, the server admin CLI, and old command/flag aliases are removed.
- CLI administration defaults to authenticated HTTP APIs; direct access requires `--via database` and an explicit target. Explicit database-directory selection takes precedence over ambient PostgreSQL connection settings.
- Remote APIs distinguish unauthenticated requests (401) from authenticated users lacking permission (403). User roles are checked from current account state; logout and per-user revocation invalidate stored server credentials.
- S3 supports refreshable AWS credential providers and temporary session tokens, while profiles contain only non-secret settings and credential references. Programmatic S3 storage options now take a `credentials` identity/provider instead of separate key fields.
- Core and the optional server library provide built JavaScript exports; workspace development uses an explicit `development` condition. The CLI requires Node.js 24 or newer.

## [0.1.0] - 2026-10-14

Initial consolidated development baseline, including work since the first commit on 2026-07-05. All five packages (`@violet-map/core`, `@violet-map/cli`, `@violet-map/server`, `@violet-map/web`, and `@violet-map/admin`) and the root workspace are versioned at `0.1.0`.

### Added

- Browser-based Minecraft Java world exploration with a Three.js viewer, Hono API, optional admin console, and offline CLI tooling.
- Shared NBT and region parsing, chunk lighting, block-model meshing, biome colors, fluid surfaces, animated textures, and resource-defined block-entity/entity renderers.
- Standard overworld, Nether, End, and custom dimension layouts, with rendering focused on modern Java 1.18+ chunk data.
- Full-detail and level-of-detail meshes, worker-based mesh compilation, camera-aware chunk scheduling, configurable performance presets, and viewer diagnostics.
- Top-map rendering with offline tile baking, stored-light or rebaked-light modes, height data, and online chunk coverage masks.
- Persistent viewer settings and camera state, plus an optional IndexedDB mesh cache.
- Local, S3-compatible, and authenticated remote-server world-storage adapters. CLI synchronization includes identity checks, same-size content verification, dry runs, optional deletion, and explicit force overrides.
- CLI commands for Minecraft asset listing/extraction, biome and dimension data generation, region profiling, and top-map baking.
- Administration for worlds, region uploads, biome data, users, and temporary credentials; guest/viewer/CI/admin/root roles with an optional environment-managed root account.
- Drizzle-backed persistent PGlite and PostgreSQL user databases, password login, and user-bound bearer credentials.
- YAML and environment configuration, development and production scripts, Docker Compose light/full profiles, and a manually dispatched world-sync workflow.
- Violet Map branding, viewer/admin icons, and a script to export branding variants.
- Package metadata as the version source, metadata-derived CLI `--version` output, coordinated and package-specific version updates with policy validation before writes, and CI validation of the shared release-line policy.
- pnpm 12, oxlint, and oxfmt tooling with lint, formatting, type checks, regression tests, and package builds in CI.
- Critical-cell ranking, bounded asynchronous work, server I/O limits, mesh-compilation optimizations, and efficient top-map height scanning.
- NBT/chunk/region validation, checked storage ranges and paths, missing-object detection, and cache invalidation after world-file writes.
- Atomic user changes, retryable database initialization, and bounded request bodies and chunk reads.
- Asset-extraction failure recovery and top-map bake/cache invalidation.
- Tile-scheduling and mesh-worker recovery, texture-atlas dimension preservation, and stale cache/mesh result protection.
