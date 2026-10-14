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
