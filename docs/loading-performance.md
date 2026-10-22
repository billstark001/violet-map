# Chunk loading performance and recovery

[Back to README](../README.md)

The viewer keeps a bounded set of chunks selected by camera importance. Completed terrain remains eligible for admission; finishing a mesh does not replace its place with another incomplete chunk. The configured view distance guarantees complete block models in a direction-independent disk, including special models. All scheduling profiles preserve that disk and reserve enough tracked capacity for it. Outside it, LOD targets use the original upgrade thresholds with downgrade hysteresis; satisfaction gaps only order work and cannot lower the promised quality. Unchanged tracker precision skips neighbor recounts, and the scheduler requests only the rankings it consumes.

Mesh jobs have separate cache lookup, waiting and Worker execution stages. Only dispatched Worker jobs occupy execution slots. A cache hit uses known content digests without requiring decoded NBT residency. Actual jobs pin their neighboring columns until completion; count and estimated byte budgets release unpinned, satisfied columns. A repeated decode of identical content does not dirty surrounding terrain. The default maximum is 384 tracked chunks (larger explicit view distances reserve at least their full-detail disk); estimated Worker residency is bounded at 128, 256 or 384 MiB according to reported device memory. In-flight dependencies can temporarily exceed that target.

The browser has one `getCachedMesh`/`putCachedMesh` API for full and LOD geometry. Disposable IndexedDB schema 8 separates geometry from small usage records. Memory retention is 32 MiB/64 entries; disk retention is 192 MiB/1,000 entries. Writes have a 32 MiB/32-operation admission bound. Opening and reading have 150 ms deadlines, and write transactions have a 1-second deadline. Storage failures become cache misses or discarded writes. Both request and transaction failures are observed, including deadline aborts. Cache work never holds a Worker slot.

Transient resolve/body failures retry with exponential backoff from 250 ms to 30 seconds, preserving displayed meshes. Absent chunks and integrity errors remain distinct. Queued reads stay retryable until a request actually starts. Worker errors, message decode errors and 30-second execution/decode stalls rebuild the pool, settle outstanding jobs and restore missing inputs. Disposal cancels requests and timers. Diagnostics expose retries, terminal errors, cache waits, estimated resident bytes, actual Worker loads, restart count and cumulative dispatch/application counts.

## Scheduling ownership

The ownership rules and module map are maintained in [viewer architecture](viewer-architecture.md). The viewer remains one package; decision, execution, resources, display and observation have explicit directory boundaries enforced by the AST boundary check.

Browser scheduling lives in `packages/web/src/scheduling/`. Browser effects live in `runtime/` and `resources/`; GPU ownership lives in `render/`. Consumers import the actual owner directly. Removed scheduling/render/cache paths have no forwarding modules or aliases.

`ChunkScheduler` has one authoritative demand map. Executor entries contain actual operation/display state, without mirrored target/attention/priority fields or an entry-based fallback. Camera planning updates desired quality independently from task completion. Dependency and repair boosts are explicit additions to that demand.

Mesh preparation and Worker execution are separate phases. Cache misses wait for inputs and then return to the scheduler's final dispatcher. Every Worker start is ranked against current demand, assigned to an available Worker and revalidated against entry identity, quality and demand age. The executor has no FIFO ready queue and cannot dispatch directly from a cache callback.

`TopMapScheduler` owns tile demand, coverage, quality and retention decisions. `TopMapRuntime` owns source identity and HTTP lifetime, and `TopMapScene` owns GPU resources. Late tile completion reads the latest demand instead of recalculating an alternative target in the executor.

Overlay source refresh belongs to `OverlayRuntime`; manifest ordering, activation/suppression and curve sampling budgets belong to pure overlay planners. `OverlayScene` applies those plans, owns graphics resources and receives a pinned-byte media loader. A shared media pool owns reference counting and cancellation.

Camera snapshots, spatial limits and surface-representation capability are shared data contracts. Sliced top views request full models instead of generating hidden LOD meshes; unusable Top Map surfaces are not admitted. GPU clipping/connectivity/frustum tests remain display concerns.

Backpressure reads actual operation state. Cached or completed empty geometry remains complete when decoded inputs are released. Retry deadlines are explicit and diagnostics never influence dispatch. Device detection is separate from the pure budget policy, and every profile preserves the configured full-detail disk.

## Repeatable real-world check

Build and start a server with the intended source world and assets. The benchmark never writes the source world. Use the same world, position, browser GPU and viewport for comparisons:

```sh
pnpm build
pnpm bench:loading --url http://127.0.0.1:3300 --world WORLD --seconds 600 --faults --views --out LOCAL_loading_acceptance
pnpm bench:loading --url http://127.0.0.1:3300 --world WORLD --seconds 120 --cache off --faults --views --compare LOCAL_loading_acceptance/stationary-final.json --out LOCAL_loading_no_cache
```

The isolated browser retains the default perspective, view distance 8, additional LOD distance 12 and medium scheduler profile. It waits up to 150 seconds for initial convergence, including pending network/retry work, then observes the full requested stationary duration. Coordinates default to `-28.3,79.4,-25.1`, yaw `155.7` and pitch `-9.8` degrees; override with `--x`, `--y`, `--z`, `--yaw`, `--pitch`. Windows defaults to ANGLE D3D11. `--gpu default` and `--gpu software` select other test environments explicitly.

With `--faults`, it injects resolve HTTP 503, short delivery leases, delayed downloads, body HTTP 409/503, a Worker error, a missing Worker response after moving, a synchronous Worker send failure and actual WebGL context loss/restoration. It rotates the view by 180 degrees, moves 96 and 192 blocks and returns to the original position after Worker recovery. These are browser-side injections; they do not restart the source server or simulate a real S3 provider outage.

With `--views`, it also switches through orthographic top view, a height slice ending at Y=48, perspective top view and the original perspective. Every transition must settle. A height slice must use full geometry, with zero surface-only LOD meshes or Top Map demands. Diagnostic exports and comparison inputs use schema 2 and the `chunkRuntime` owner; the benchmark rejects older schemas rather than inferring missing state.

Success requires full-model terrain throughout the default eight-chunk full-detail disk (or explicit source absence), visible terrain, no terminal errors, no pending retries/cache waits/Worker work or active resolve/body batches, bounded tracking, and no growth in chunk dispatches, mesh requests, mesh applications or retries during the stationary interval. Worker faults must rebuild the pool and settle again. Injected failures and retryable resource admission/lease rejections may recover; other HTTP failures, browser errors or console errors fail the run. The script closes its isolated browser even on failure; the operator remains responsible for stopping the test server.

`report.json`, live samples, diagnostic snapshots and before/after screenshots are written beneath `--out`. Keep these ignored local artifacts when diagnosing a failure. Check context-restored screenshots as well as the counters. Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm boundary:check`, `pnpm test:frontend`, `pnpm test:transparency` and `pnpm test:overlays` for the matching automated coverage. Small synthetic rendering acceptance checks correctness and ownership; it does not establish large-world GPU throughput.

Network totals count encoded HTTP response bodies separately from the viewer's decoded NBT counter. Artifact totals recognize the server resource and public CAS URL layouts; custom CDN layouts remain included in overall totals. `--profile` saves a Chromium CPU profile, performance metrics and animation-frame intervals (FPS and median/P95/P99) for the stationary interval. Profiling adds measurement overhead; CPU samples are not GPU timings, and animation-frame intervals measure browser presentation cadence rather than individual GPU pass time. Compare sequential runs with the same complete resources and no competing validation workloads.

Use `--compare PATH/TO/stationary-final.json` on the opposite cache policy to compare the full-detail chunk set and geometry byte counts at the same position and render identity. A complete neighborhood cache key requires all known inputs to be resident before generation; partial first-display geometry cannot enter that cache. Mesh render key version 19 invalidates previously generated partial-neighborhood entries.

## API, lifetime and performance verification (2026-10-23)

The subsequent cleanup removed parallel Worker/version/load registries, cache-job fields and full/LOD readiness flags. Mesh jobs own execution and cache lifetime, display feedback owns available geometry, and request records own network admission. Retiring canceled transfers retain their budget until settlement; only live transfers accept new owners. Shared metadata and body requests use the same per-caller cancellation mechanism, including synchronous transport cancellation by the last owner. Browser acceptance also switches worlds while render resources are still preparing, requiring the latest world to own the first terrain context.

Strict wire decoders reject incomplete chunk coverage, Top Map manifests/artifact identity and malformed resource errors. Invalid coverage cannot fabricate source holes. Mesh-cache callers supply one explicit quality step, and Worker decode deadlines have no missing-timestamp extension. Sky images finish verified loading before terrain starts; retryable transport failures no longer leave fabricated celestial textures permanently displayed. Minecraft's supported image layouts are selected only by explicit source absence.

The same real save, camera, view/LOD 8/12, medium profile, two Workers, 1440×1000 at DPR 1 and Intel UHD/ANGLE D3D11 passed a further 602.4-second stationary interval. Dispatches stayed at 391, mesh requests/applications at 421 and cumulative retries at 33. A fresh cache-disabled run passed 62.6 seconds, with dispatches at 386, mesh requests/applications at 422 and retries at 33. Both retained 197 full-detail and 187 LOD chunks within 384 entries, with 100,416,152 geometry bytes. All 197 full-detail chunk keys and individual geometry byte counts matched the established baseline in both runs. Neither run created new dispatches, mesh jobs or retries while stationary.

Both runs passed transport/lease failures, rotation and movement, three Worker-pool rebuilds (Worker error, missing response and synchronous send failure), actual WebGL restoration and every orthographic/perspective/slice transition. Settled states had no outstanding jobs, dependency pins, retries or terminal errors. Height slices admitted no unusable surface LOD or Top Map representation. Attention history was bounded at four cached grid chunks and 1,257 active cells in the original view, with a 64-chunk inactive-history allowance; movement and observational-query regressions independently exercise its bound and state isolation.

Static terrain is culled once per frame before transparency pass preparation. A synthetic 2,000-mesh acceptance reduced sphere tests from 6,000 to 2,000 while preserving pixels, including parent movement, geometry changes, direct matrix updates and exception restoration. Derived world bounds invalidate on actual matrix or geometry-sphere changes. An isolated same-browser experiment alternated six 20-second intervals with and without the world-bound cache: weighted animation-frame cadence was 44.42 versus 43.54 FPS (about 2%). This measures a modest local CPU-side benefit, not GPU time or a general frame-rate guarantee. Sixteen transparency bins and the 3,145,728-pixel target cap remain unchanged.

Final automated checks passed: the full build, typecheck, lint, formatting, architecture boundaries, 399 unit tests, four frontend browser checks and overlay/transparency browser acceptance. Four PostgreSQL checks were skipped. The complete unit suite was repeated without concurrent rendering after one CLI subprocess exceeded its deadline under competing validation load; its isolated rerun and the complete uncontended rerun both passed.

The test server disabled source mutation and publication. Its write guard recorded zero attempted writes to the game data directory. All 13,936 files beneath `.minecraft` retained their sizes and modification/change timestamps. Generated assets, caches, databases and reports stayed in ignored project output or temporary directories. Verification servers and isolated browsers were closed.

## Quality-preserving verification (2026-10-22)

Same save, camera, default view/LOD 8/12, medium profile, two Workers, 1440×1000 at DPR 1 and Intel UHD Graphics through ANGLE D3D11. The full-detail disk now contains 197 complete-model chunks, with 187 additional LOD chunks retained within the unchanged 384-entry default limit. Geometry retention is 100,416,152 bytes (95.76 MiB); restoring the requested detail necessarily retains more geometry than the earlier 54-full-chunk run.

The cached run stayed stationary for 606 seconds after convergence. Source dispatches stayed at 384, actual mesh requests/applications at 424 and retry count at 33 (including the injected initial failures). There were no new dispatches, mesh jobs or retries in that interval. All final queues, terminal errors and pending retries were zero. Rotation, movement, a Worker error, a missing response requiring the 30-second watchdog, and actual WebGL context restoration settled again with 197 full-detail chunks. Two pool rebuilds were observed. Boundary face counts may change after navigation because the admitted outside neighborhood changes; the full-detail disk remains fixed at a given position.

A separate cache-disabled run stayed stationary for 120 seconds. All 197 full-detail chunk keys and geometry byte counts matched the cached run at the original position. Both cache policies also passed the same transport, Worker and WebGL fault suite, with two Worker-pool rebuilds and no terminal errors. All 5,430 source file sizes and local revision tokens remained unchanged; the verification server and isolated browsers were stopped. These checks establish retained detail, loading convergence and recovery; they do not establish a frame-rate guarantee for every device. The WebGL acceptance also requires an unscaled 2560×1080 target, so reducing the transparency pixel cap cannot silently pass the quality check.

## Ownership and GPU lifecycle verification (2026-10-23)

The complete ownership refactor retained the same real save, camera, view/LOD 8/12, medium profile and ANGLE D3D11 configuration. A cached run observed 606.1 seconds between its settled snapshots. Source dispatches stayed at 386, mesh requests/applications at 419 and cumulative retries at 33. All 197 full-detail chunk keys and individual geometry byte counts matched the established baseline. The stationary view retained 187 additional LOD chunks, 384 entries and 100,416,152 geometry bytes.

A fresh cache-disabled run passed 123.1 seconds of stationary observation and the complete transport, Worker and WebGL fault suite. It exercised a synchronous Worker send failure as well as a Worker error and the missing-response watchdog; three pool rebuilds settled without stranded jobs, pins or terminal errors. Orthographic top view, a slice ending at Y=48, perspective top view and restored perspective all settled. Slices had no surface-only LOD meshes or Top Map demands, and resetting the slice restored LOD eligibility.

The final build, including planner-owned pin constraints, passed another 60-second stationary run, all 197 baseline geometry comparisons, three Worker-pool rebuilds, WebGL restoration and every view/slice transition. Dispatches stayed at 388, mesh requests/applications at 419 and retries at 33 during that final stationary interval. A separate WebGL ownership check repeated five Top Map load/replacement/hide/restore/dispose cycles at steps 8/4/2/8: pixels stayed identical and GPU geometry/texture counts returned to their starting values. This exposed and removed two globally retained placeholder animation textures from static Top Map materials.

Final automated checks passed: build, typecheck, lint, formatting, architecture boundaries, 370 unit tests and frontend/overlay/transparency browser acceptance. Four PostgreSQL checks were skipped. Focused regressions also cover revoking a dispatch plan after a synchronous send failure, invalid/mismatched Worker precision replies, and planning eviction around pending work and dependency pins. Source mutation and publication were disabled; a write guard rejected source mutation paths. All 13,936 game-instance file sizes and modification/change timestamps remained unchanged, with zero attempted source writes recorded. Verification browsers and the server were closed. These runs establish retained detail, bounded convergence and recovery; the concurrent validation workload is not a controlled FPS or cold-start benchmark.

## Verification after the scheduling responsibility split (2026-10-22)

The same real save, default view/LOD 8/12 and rendering configuration passed a further 604.7-second stationary interval. Dispatches stayed at 384, mesh requests/applications at 426 and cumulative retries at 33, including the injected startup failures. All 197 full-detail chunk keys and their individual geometry byte counts matched the quality-preserving baseline above. The 187 additional LOD chunks remained displayed. Transport/lease failures, rotation, movement, a Worker error, a missing Worker response and actual WebGL loss/restoration all settled; two Worker-pool rebuilds left no active requests, jobs, retries or terminal errors. This checks convergence and retained detail, without claiming a controlled loading-time or FPS improvement.

A fresh cache-disabled run also passed 120 seconds of stationary observation and the complete fault suite on the final code. All 197 full-detail chunk keys and geometry byte counts matched the cached run. All 5,430 source file sizes and local revision tokens were unchanged; the isolated browsers and verification server were stopped. Regression coverage includes request generations, retry wake times, attention preservation, quality-consistent dispatch/acceptance, invalidation targets, Worker restart/transfer failures, GPU ownership and obsolete top-map failures.

A final pre-commit review added refresh-generation regression coverage and corrected the acceptance script to look up source coverage by the service world ID, independently of the scoped diagnostic/cache identity. Missing source coverage now fails acceptance; sparse and unmasked-region coverage have focused regression tests. The final code passed another 120-second stationary run, all 197 geometry comparisons and the complete transport/Worker/WebGL fault suite. Automated checks passed: build, typecheck, lint, formatting, package boundaries, 353 unit tests (four PostgreSQL checks skipped), and frontend/transparency/overlay browser acceptance. The source inventory remained unchanged and verification processes were stopped.

## Historical convergence run before the quality correction (2026-10-22)

The following run had only 54 full-detail chunks and the reduced transparency pixel cap. It established recovery, but did not establish visual-quality preservation; do not use it as quality acceptance.

Windows, Chromium 156, Intel UHD Graphics through ANGLE D3D11, 1440×1000 at DPR 1; `Surv#Vanilla` at the default benchmark position, view/LOD 8/12, medium profile and two Workers. The source server used bounded consistency, server delivery, a 256 MiB work budget and eight admitted resource tasks.

| Check | Result |
| --- | --- |
| 600-second stationary interval after convergence | 384 displayed chunks (54 full, 330 LOD); dispatch, mesh-request and mesh-application counts unchanged |
| Cache disabled, 120-second stationary interval | Settled; all 54 full-detail chunk keys and geometry byte counts matched the cached run |
| Resolve/body failure and lease expiry | Retried and settled without terminal errors |
| 180-degree turn, 96-block move and return | Settled after each transition |
| Worker error and missing response | Two pool rebuilds; no retained execution slots or stalled chunks |
| WebGL context loss/restoration | Terrain visible again; no browser errors |
| Original save inventory | All 5,430 file sizes and local revision tokens unchanged |

Admission backpressure occurred while multiple validation clients and workspace tests ran concurrently; retries settled before the stationary interval and did not keep increasing. These runs establish convergence and recovery, not an unloaded-machine FPS or cold-start latency guarantee. Reports and restored-context screenshots are retained in ignored local validation output.

For 32 real chunks with source retention disabled, sequential region reads fell from 317,046,784 to 778,240 bytes; grouped reads fell from 10,399,744 to 397,312 bytes. Both produced 1,739,080 decoded bytes. This measures source I/O, separately from HTTP transfer bytes and decoded Worker residency. Live S3-provider and non-Windows GPU runs were not part of this local verification.
