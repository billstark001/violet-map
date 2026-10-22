# Development and releases

[Back to README](../README.md)

## Packages

| Package | Purpose |
| --- | --- |
| `@violet-map/core` | Neutral world data, NBT/region codecs, top-map formats, HTTP contracts, storage interfaces and concurrency utilities. |
| `@violet-map/render` | CPU models, lighting, colors, meshes and top-map sampling/geometry; depends only on core. |
| `@violet-map/storage` | Local/S3/HTTP adapters, caching, prefixes and synchronization; depends only on core. |
| `@violet-map/cli` | The `violet-map` CLI: assets, maps, profiles, credentials, and API/direct user administration. |
| `@violet-map/server` | Hono API, world service, database/user services, and a side-effect-free optional `server/admin` library. |
| `@violet-map/web` | Browser viewer with separate scheduling, execution, resource, display and diagnostic owners; see [viewer architecture](viewer-architecture.md). |
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
pnpm test:transparency
```

These commands run on Windows, macOS and Linux without Unix shell environment assignments. Asset extraction reads JARs in Node and does not require `unzip`. Artifact and benchmark subprocesses reuse the active pnpm executable; run their checks through the documented pnpm scripts. Browser checks use installed Chrome on macOS when available, otherwise Playwright Chromium; `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` explicitly selects another executable.

Git keeps text files as LF on every platform through `.gitattributes`, so `format:check` also works with Windows `core.autocrlf=true`.

CI includes native Windows and macOS jobs for unit tests, builds, relocated artifacts and frontend acceptance, alongside Linux verification with PostgreSQL and containers.

To exercise the real OS credential store on a machine with an unlocked keychain, run `pnpm --filter @violet-map/cli test:keychain` explicitly. This integration test uses a temporary CLI home and its isolated random keychain namespace, checks native write/read/update/delete and the application's replacement lifecycle, and verifies cleanup of every test entry and the temporary directory. It never reads or changes existing CLI credentials. It is excluded from `pnpm test` and CI because those environments may not have an accessible credential store.

## Versions and changelog

Each package's `package.json` is the source of truth for its version; executable versions are read from that metadata. Run `pnpm violet-map --version` to inspect the CLI version; every subcommand uses that package version.

[CHANGELOG.md](../CHANGELOG.md) records releases and the version policy. `pnpm version:check` validates every package's semantic version and enforces a shared MAJOR, plus a shared MINOR while MAJOR is `0`. Package PATCH versions may differ; after `1.0.0`, MINOR versions may also differ. CI runs this check.

For a coordinated release, run `pnpm version:set <version>` (for example, `pnpm version:set 0.3.0-rc.1`) to update the root and all workspace manifests. To update one package, use its exact metadata name: `pnpm version:set 0.3.1 --package @violet-map/cli`. The `--package` option may also precede the version. Both modes validate the entire proposed workspace against the version policy before writing any files; a targeted update leaves all other manifests unchanged. Add the corresponding changelog entry and run the production checks before publishing; these commands only update or validate local metadata and do not create commits, tags, or publications. Minecraft, cache, and file-format versions advance independently of package versions.

## CI/CD

`.github/workflows/ci.yml` installs immutable dependencies, runs lint, formatting, type checks, and focused Node tests, then builds all packages on pushes and pull requests. The tests cover storage consistency, map processing, CLI parsing/configuration/secrets, API authorization, shared world-sync logins, and direct management on PGlite/PostgreSQL. Relocated CLI tests run built JavaScript without server, TypeScript sources, tsx, or a native keyring, then exercise optional direct access after adding server.

`.github/workflows/world-sync.yml` is manually dispatched. Configure repository secrets for either destination:

- Server: `VIOLET_SERVER_URL`, `VIOLET_SERVER_TOKEN`
- S3: `S3_BUCKET`, `S3_ENDPOINT` (optional), `S3_REGION`, `S3_PREFIX` (optional), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_SESSION_TOKEN` (optional)

The workflow accepts the checked-in archive directory, target world name, destination type, and explicit `delete`/`force` switches. Use an issued CI credential with the least privilege necessary.

Production artifacts and independent Docker services are described in [deployment](deployment.md). CI also runs AST package-boundary checks, relocated production server tests, package publication checks and three-origin browser acceptance with static/API prefixes.

Overlay validation, the isolated S3 option, resource budgets and paired binary/config rollback are described in [overlay release acceptance](overlay-release-acceptance.md). `test:release` builds the pre-overlay Git revision to exercise actual old binaries and uses temporary directories. `VIOLET_ACCEPTANCE_ENV_FILE` opts into an existing S3/R2 bucket under a random isolated prefix; no extra hosted service is required. Without it only that S3 case is skipped. Use local PostgreSQL with `TEST_DATABASE_URL` to include all database cases.

## Performance measurements

For native browser mesh-cache measurements, run `pnpm exec tsx scripts/bench/mesh-cache.ts 500`. It starts an isolated Vite/browser session and compares cold IndexedDB clones against warm immutable-buffer reuse at 4 KiB, 256 KiB and 4 MiB. The optional argument is the measured rounds per case (1–10000); each case has ten warmup rounds. Browser timer resolution may round very short warm reads to zero. Use the reported browser, payload size and percentiles when comparing results; this measures cache access rather than overall frame time.

For server decompression measurements, run `pnpm exec tsx scripts/bench/chunk-decode.ts /path/to/r.0.0.mca /path/to/r.-1.-1.mca`. Supply one or two regions; the benchmark selects each region's eight largest compressed records, verifies byte-for-byte codec agreement, and compares portable pako, native synchronous zlib and native asynchronous zlib over twenty batches. It reports batch latency and timer delay, including the exact-size output copy used by the server. Only the supplied files are read, and no world data is copied into the repository. On the local village sample with Node 26.8.1, sixteen chunks took about 5.1 ms per batch with pako and 2.6 ms asynchronously; timer delay dropped from about 5.7 ms to 1.3 ms. These numbers describe decompression, not complete request latency, and depend on the host and chosen records.

For stored-height-map measurements, run `pnpm exec tsx --conditions=development scripts/bench/chunk-height.ts /path/to/r.0.0.mca /path/to/r.-1.-1.mca`. It uses the same sixteen hard records at most, checks every local height against scanning, and adds a five-by-five validation grid per supplied region. Timings include `parseChunkColumn` and all 256 height queries, including calibration, but exclude NBT decompression. Thirty measured rounds follow five warmups. The village sample improved from about 15.5 ms to 5.7–6.5 ms per sixteen-chunk batch after reading the correctly cased `Heightmaps` tag. This does not measure complete meshing or frame time.

For a read-only server-cache soak, run `pnpm exec tsx --conditions=development --expose-gc scripts/bench/server-cache.ts /path/to/world 1200`. The world must contain modern overworld `r.0.0.mca` and `r.-1.-1.mca`; only those terrain files provide samples. The server may also read their corresponding entity sidecars. A seeded mix of hard/random chunks is checked against decoded terrain hashes in batches of eight, with 250 ms between batches and 30-second post-GC memory reports. Writes are blocked by the storage adapter. Region/chunk budgets are deliberately small (8 MiB / 1 MiB) to exercise bypass and eviction; the duration is 1–3600 seconds (default 60). The 20-minute village baseline completed 35,816 verified chunk reads. A subsequent 60-minute run completed 109,384 reads from 192 hard/random samples, kept chunk retention below 1 MiB (maximum 1,048,525 bytes), and held periodic post-GC JS heap around 16.1–16.4 MiB after five minutes of warmup. The final summary used 18.3 MiB heap, including report construction. Eight-chunk batch p50/p95 was about 9.1/21.2 ms; this was a correctness/budget soak with concurrent development, rather than a controlled throughput comparison. RSS/native allocator and active-request buffers are reported separately and are not the cache budget.

For packed palette decoding, run `pnpm exec tsx --conditions=development scripts/bench/packed-array.ts /path/to/r.0.0.mca /path/to/r.-1.-1.mca`. Real block/biome bit arrays from the hard records are verified against BigInt extraction, then measured in twenty rounds of 500 decodes after five warmups. The original BigInt loop runs alongside the current implementation in each round. On Apple M3 / Node 26.8.1, sampled 4096-value block arrays dropped from about 0.04–0.07 ms to 0.006–0.010 ms per decode. These are palette-decoding measurements; complete chunk/frame improvements also depend on lighting and meshing.

For object-content comparison, run `pnpm exec tsx --conditions=development scripts/bench/object-compare.ts /path/to/r.0.0.mca`. It compares the previous copy-before-digest path with `compareObjectContent`, interleaved over thirty rounds after five warmups. Reads reuse their buffers so the measurement isolates size checks and SHA-256 comparison; storage I/O and copying changed objects are excluded. On the 8 MiB village region, the median decreased from about 4.5 ms to 3.6 ms, with two full-file JavaScript copies (16 MiB total) removed per comparison. WebCrypto still takes its own input snapshot; shared backing is explicitly copied to an ordinary ArrayBuffer.

For column lighting, run `pnpm exec tsx --conditions=development scripts/bench/lighting.ts /path/to/r.0.0.mca /path/to/r.-1.-1.mca`. It forces block, sky and combined lighting on the same hard records, using the installed 1.21.4 registry plus default overrides. Parsing and digest validation are outside the timed interval; ten rounds follow two warmups. Result digests allow before/after byte comparison. Replacing per-voxel section writeback with owned typed-array spans preserved all three digests on the sixteen village samples and reduced measured medians from about 16.3/36.5/45.1 ms to 14.5/33.8/41.1 ms respectively. This measures forced fallback lighting, not the saved-light path or complete meshing.

For overlay triangulation, run `pnpm exec tsx --conditions=development scripts/bench/triangulation.ts`. Deterministic convex and concave star rings contain 64, 512 and 2048 points; polygon area and triangle centroids are checked outside timing. Twenty measured rounds follow five warmups. On Apple M3 / Node 26.8.1, the 2048-point cases changed from about 9.6/8.7 ms with the handwritten ear clipper to 2.8/1.1 ms using [Earcut](https://github.com/mapbox/earcut), including the local-coordinate conversion and area-deviation guard. Winding is retained and holes/self-intersections remain outside the supported format.

For local object reads, run `pnpm exec tsx --conditions=development scripts/bench/storage-read.ts /path/to/r.0.0.mca`. It interleaves the previous read-and-copy path with `LocalStorage.read` over thirty measured rounds after five warmups, checking all returned bytes outside timing. On the warm 8 MiB village region, medians were about 1.32 ms and 1.16 ms. Full filesystem allocations can be adopted without a second full-file copy; pooled and short-read views are copied to exact-size ordinary arrays so retained cache budgets do not pin unrelated bytes. Cold disk/network filesystems can dominate these timings.

For index-buffer packing, run `pnpm exec tsx --conditions=development scripts/bench/mesh-packing.ts`. It interleaves the previous JavaScript loop and native typed-array conversion at 6,144, 98,304 and 393,216 indices, using nonzero-offset input views and validating every result outside timing. On Apple M3 / Node 26.8.1 the medians were approximately 0.005/0.072/0.289 ms for the loop and 0.001/0.019/0.087 ms for native conversion. These timings cover conversion/allocation rather than meshing or frame time. Meshes with exactly 65,536 vertices can also use 16-bit indices.

Mesh diagnostics report encoded attribute bytes for GPU upload estimates. CPU mesh caches and their pending structured-clone queue instead budget complete backing allocations, counting shared attributes once per mesh. Writer capacity can exceed the visible array length. IndexedDB schema 7 clears the derived older cache once because its stored byte counters omitted that capacity.

For binary response delivery, run `pnpm exec tsx --conditions=development scripts/bench/http-bytes.ts`. It alternates full-buffer slicing and exact typed views over actual Hono Node HTTP loopback requests, consuming each 8 MiB body and checking SHA-256 outside timing. On Apple M3 / Node 26.8.1 the medians were approximately 8.2 ms and 6.3 ms over twenty measured rounds after five warmups. The installed Hono Node adapter directly sends typed-array responses; application buffers remain immutable while in use. Network and client consumption are included, so use the result as a local comparison rather than an egress throughput promise.

For registered entity-model baking, run `pnpm exec tsx --conditions=development scripts/bench/model-baking.ts`. It requests the same 12-quad model 1000 times per round, excludes instance transforms/mesh emission, and checks the geometry/UV/texture digest outside timing. Thirty measured rounds after five warmups gave approximately 2.78 ms before shared variant caching and 0.11 ms afterward on Apple M3 / Node 26.8.1, with identical digests. Returned cached quads are immutable inputs to each instance's transform; separate GPU instances still have their own placement.

For optional content-import startup cost, run `pnpm exec tsx --conditions=development scripts/bench/content-startup.ts`. It starts five fresh Node processes, times the content-service module import, forces GC and reports memory plus native Sharp loading. On Apple M3 / Node 26.8.1, eager inspection imports took about 64 ms / 10.7 MB heap / 98 MB RSS; deferring inspection until a media upload took about 6 ms / 7.8 MB heap / 76 MB RSS. This measures the isolated module graph, excluding process launch and actual media import; first media uploads still pay decoder initialization. Read-only and content-disabled servers avoid that initialization.

The triangulation benchmark also reports `validationP50Ms` separately for the core input-geometry guard. Disjoint edge bounds skip orientation/touch calculations while retaining inclusive contact detection. For 2048-point convex/star contours, medians changed from approximately 40/39 ms to 8/14 ms on Apple M3 / Node 26.8.1. The worst-case pair enumeration remains quadratic; these are common-contour pruning gains, not a new asymptotic bound.
