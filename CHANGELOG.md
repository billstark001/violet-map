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

### Fixed

- CLI `overlay manifest` supports public read-only servers without requiring an admin capability or login; its anonymous requests omit saved/injected credentials.

- Restricted browser history no longer interrupts camera targeting or animation; URL persistence tolerates sandbox restrictions and history rate limits, independently of local-storage persistence.

- Model texture variables such as `constructor`, `toString` and `__proto__` resolve through normal inheritance; missing variables use the fallback instead of inherited JavaScript prototype values.

- Content metadata mutations reserve configurable bounded capacity before buffering JSON; queued requests keep bodies unread and excess traffic gets retryable `CONTENT_BUSY`, independently of media imports.

- Small valid overlay regions near the world border no longer fail zero-area validation because large absolute-coordinate products cancel; either winding remains supported.

- Published map/layer/media metadata must match its object-key identity and revision; misplaced but otherwise valid JSON reports `CORRUPT_CONTENT` instead of serving another publication. Map discovery matches literal `.json` suffixes.

- Mesh cache and pending-clone budgets count complete retained buffers instead of only attribute views, deduplicating shared attribute backing. The derived IndexedDB cache rebuilds once to remove obsolete byte accounting.

- Another page blocking an IndexedDB upgrade no longer stalls terrain work: cache operations fail promptly and recover when the old connection closes. New cache connections yield to later schema upgrades.

- Overlay manifest requests time out after 30 seconds, allowing retries after stalled connections while retaining the last valid same-context content.

- Remote uploads accept shared-backed byte arrays and preserve subarray boundaries without an extra full-file JavaScript copy for ordinary buffers.

- S3-compatible range reads also handle full 200 responses correctly; object bodies use the SDK's typed stream conversion instead of a separate hand-written compatibility collector.

- Disposed camera controls stop held-key motion and release pointer ownership; lost pointer capture ends top-view dragging, and denied/unsupported pointer lock does not create unhandled errors.

- Weighted LRU insertion evicts before adding weights, avoiding an infinite eviction loop when finite weights overflow their sum; unbounded totals recover after deletion.

- Remote storage range reads honor the requested slice when a server/proxy legally ignores Range and returns a full 200 response; returned slices do not retain the full response buffer.

- Failed media reads no longer attach the original asset length, MIME type or validators to a JSON error, avoiding truncated/hanging HTTP responses. Conditional cross-origin HEAD is included in CORS methods.

- Media imports reserve configurable bounded capacity before reading uploads or decoding assets, limiting concurrent memory pressure; an exhausted queue returns retryable 503 without buffering another upload.

- Viewer disposal cancels bootstrap metadata, atlas and colormap requests, plus late sky-texture loads; aborted atlas work no longer starts the individual-texture fallback. Image completion and failure detach handlers.

- Fallback atlas identities include UV placement, texture alpha classification and LOD average colors, avoiding stale meshes when packs change under the same texture names or packing order changes.

- Mesh resource identities include biome definitions and dimension lighting rules, preventing stale IndexedDB meshes from retaining old tint/light after configuration edits and reloads.

- Local game-data overrides now use the same atomic object replacement as mounted overrides; failed publication preserves the previous complete JSON file and cleans temporary files.

- Biome edits validate finite climate values, complete RGB effects and supported modifiers before publication, and use bounded JSON reads; rejected edits leave the last usable data intact.

- World sync diff JSON is bounded by the configured upload budget and validates every file entry/path before starting remote hashes; malformed requests return 400/413 without backend work.

- Local storage adopts exclusive filesystem read buffers instead of copying large files twice; pooled and short-read buffers are trimmed to exact-size owned arrays.

- Curve sampling and area-mask layout reject nonfinite budgets and inverted bounds before generating invalid GPU dimensions; public geometry helpers document coordinate units and ownership.

- Area triangulation uses Earcut with local coordinates and an area-deviation guard, improving large concave overlays while preserving original vertex indices and winding.

- Fallback lighting copies contiguous section channels in bulk while preserving independent section buffers and untouched channels; real-world output digests remain unchanged.

- Region discovery and uploads share bounded Anvil filename parsing; impossible region/chunk filenames no longer produce unsafe coverage coordinates.

- Object synchronization hashes byte views directly instead of copying both complete objects before WebCrypto; shared backing remains supported with an explicit ordinary-buffer copy.

- Chunk deletion validates the entire batch before touching storage, preventing malformed later entries from causing partial deletion followed by an error.

- Dimension validation rejects `.`/`..` namespaces; malformed encoded archive directories no longer break world discovery. CLI and server share dimension paths, including custom paths containing a `region` segment.

- Overlay resource pools reject invalid budgets/concurrency immediately, preventing NaN limits from disabling bounds and zero concurrency from leaving promises pending forever.

- Chunk parsing rejects out-of-range/duplicate section coordinates, oversized palettes and invalid chunk coordinates before height-dependent work, avoiding runaway loops on malformed archives. Resource namespace normalization and signed chunk-coordinate validation now have one shared implementation.

- Media proxy responses evaluate conditional requests, HEAD, and unsatisfiable ranges before blob I/O; satisfiable ranges read only the requested bytes. Weak/list ETags and strong If-Range validators are handled correctly.

- Database maintenance and direct admin imports retain their small runtime dependency set when media URL configuration is enabled; relocated maintenance artifacts no longer require storage or AWS packages.

- Camera movement consumes browser selection/scroll shortcuts outside editable controls, including Ctrl+A on Windows; right Control and Shift now match their left-hand counterparts.
- Glass and ice remove touching internal faces through explicit block metadata, while leaves and different glass colors retain theirs. Inset/rotated model faces no longer cull neighbors solely by their projected bounding box. Existing mesh cache entries are invalidated.
- Disconnected tunnels now union section-visibility connections correctly; duplicate connections previously carried into other bits and could hide reachable terrain.
- Visibility traversal tracks section entrances separately, preserving reachable independent tunnels, while zero-connectivity solid boundaries stop traversal. Scratch queues release section references after use; worker/viewer share the mesher's full-connectivity constant.
- Storage metadata caches now bound retained keys and aggregate list items, including negative lookups; long-running read-only servers no longer retain every path ever probed.
- Legacy overworld entity sidecars resolve to `entities/` rather than rereading terrain from `region/`. Warm chunk reads reuse entity NBT and hashes, and world deletion releases cached region/header bytes immediately.
- Unavailable or failing IndexedDB now falls back to worker meshing instead of repeatedly retrying a failed cache read with missing terrain.
- Partial camera/look-at URLs retain unspecified coordinates instead of turning them into zero; restricted browser storage no longer prevents viewer initialization.
- Overlay media downloads cancel as soon as their pinned byte budget is exceeded, including responses without Content-Length. Upload/download readers share the same bounded streaming helper.
- Admin actions report HTTP/network failures without unhandled promises, serialize duplicate submissions and cancel stale panel reads. Restricted browser storage is tolerated during language/session initialization.
- World names reject `.` and `..` before storage access; `.` previously normalized to the entire worlds mount during direct deletion/synchronization. Server, CLI and content registration share this validation. Invalid creation metadata is rejected before partial writes, and encoded world names no longer shift uploaded file paths.
- Local filesystem-root mounts now resolve children correctly; S3 listings normalize root-equivalent prefixes consistently. Metadata caches reuse canonical paths instead of retaining duplicate spellings.
- Disposing/switching a world aborts chunk/coverage/hash requests and suppresses late IO callbacks. Capability requests are also cancelled on world changes. Malformed batch payloads fail explicitly instead of marking valid terrain absent.
- Canonical Java `Heightmaps.WORLD_SURFACE` data is used instead of being ignored because of a tag-case typo. Packing and vertical offsets are checked against scanned samples, including light-only boundary sections; malformed/stale samples fall back to scanning. Height queries wrap local coordinates consistently.

### Changed

- Registered entity models reuse the same baked-variant cache as block models, avoiding repeated base-geometry baking for each instance while keeping transforms independent.

- Binary HTTP responses reuse exact ordinary byte views across media, textures, top-map, storage and MessagePack routes, avoiding redundant whole-payload copies and using Hono Node's typed-array response path. Shared backing is copied before delivery.

- Content mutations reuse repeated layer/media reference reads within that mutation, while checking each instance's placement and rechecking publication state on the next operation.

- Server imports and viewer decoding share one static GLB support-policy parser; deep metadata traversal no longer depends on recursive JavaScript calls. Full glTF validation remains a server publication check.

- Server region, chunk, texture and manifest caches share bounded LRU accounting; oversized region/chunk buffers bypass retention without flushing useful residents. Texture-path and world-directory lookups are also bounded.
- A 32 MiB / 64-entry CPU mesh cache reuses immutable full/LOD buffers before IndexedDB cloning. Disabling or clearing the mesh cache releases these references as well.
- Server chunk/entity decoding uses Node's asynchronous native zlib codecs, sharing Anvil validation with core. Cached decoded buffers own their exact backing allocation, and uploaded chunks are decompressed only once before parsing and storage.
- WebGL initialization, camera controls, world changes and disposal now live in an independent viewer controller. The frame timer uses page visibility to avoid movement jumps after background tabs resume.
- Web uses native Preact, signals-backed translations and accessible native form/tab controls, removing React, Radix and react-i18next from the viewer. React aliases/compat are disabled and checked by the package-boundary tooling. Admin continues to use React.
- Viewer UI is split into view/settings/diagnostic panels and camera fields with CSS Modules. Shared world loading, capabilities, settings and diagnostics use signals; the canvas lives outside the UI tree. World-list failures can be retried, URL overrides remain session-local, and blank camera inputs no longer silently become zero.
- Removed deprecated `WorldReader`/`WorldStorage`, world-named local/S3/cache/scope class aliases, `createWorldStorage`, and `AppServices.storage`. Consumers now use object-storage names and `services.mounts.worlds`; the distinct remote `ServerWorldStorage` protocol remains supported.
- Admin is split into a small application shell, independent panels and shared async/session controls. Account menus show verified identity/role, check sessions and revoke user credentials on logout; destructive actions use retryable confirmation dialogs.
- S3 prefix deletion uses up to four concurrent SDK `DeleteObjects` batches of at most 1000 keys, rather than one request per object. Per-object errors in HTTP-success responses reject the operation explicitly.
- Region-only chunk batches avoid one missing override-object stat/HEAD per coordinate. A shared directory probe discovers whether overrides exist, and normal writes invalidate that probe immediately.
- Packed block/biome/height indices up to 32 bits decode through endian-aware zero-copy word views, avoiding BigInt operations per value. Wider public bit widths retain their Number semantics; all 64 widths are checked against BigInt extraction.
- CLI and server share neutral block-info construction and ordered wildcard overrides through `core/assets`; dictionary overrides cannot replace the map prototype.

### Added

- A shared weighted LRU cache in `core/cache`, with entry/weight limits and oversized-value bypass, for consistent memory accounting across packages.
- Opt-in public media object URLs alongside API proxies: configure `MEDIA_PUBLIC_BASE_URL`, request `delivery=public`, and verify pinned size/digest on either path. The viewer falls back to the proxy on public delivery failures; runtime `mediaDelivery: proxy` forces proxy use. Original manifest requests retain their wire format.

## [0.2.0] - 2026-10-17

### Added

- External map registrations, immutable overlay revisions and media versions, conditional content APIs and CLI management, named local/S3 storage mounts and independent diagnostics credentials.
- Adaptive Bezier curves, terrain-fragment region masks, finite double-sided walls, PNG/JPEG/WebP/SVG placement and static GLB instances with label/scene lighting, lazy loading, shared pinned resources and bounded disposal.
- Production WebGL acceptance with fixed camera paths, pressure/cancellation/heap checks, isolated real-S3 restore and actual pre-overlay binary/config rollback tests.
- Private quiesced content/blob snapshots and verified empty-target recovery; Railway incremental/full deployment now snapshots external content before world updates.

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

### Deprecated

- Published world-storage interfaces/classes/factory and `AppServices.storage` remain available with deprecation annotations; object-storage names and logical mounts are authoritative. HTTP world paths, CLI synchronization and identity rules remain supported. New internal compatibility aliases are not introduced.

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
