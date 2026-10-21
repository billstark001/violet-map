# Chunk loading performance and recovery

[Back to README](../README.md)

The viewer keeps a bounded set of chunks selected by camera importance. Completed terrain remains eligible for admission; finishing a mesh does not replace its place with another incomplete chunk. LOD targets depend on importance with hysteresis, while satisfaction gaps order work. Unchanged tracker precision skips neighbor recounts, and the scheduler requests only the rankings it consumes.

Mesh jobs have separate cache lookup, waiting and Worker execution stages. Only dispatched Worker jobs occupy execution slots. A cache hit uses known content digests without requiring decoded NBT residency. Actual jobs pin their neighboring columns until completion; count and estimated byte budgets release unpinned, satisfied columns. A repeated decode of identical content does not dirty surrounding terrain. The default maximum is 384 tracked chunks; estimated Worker residency is bounded at 128, 256 or 384 MiB according to reported device memory. In-flight dependencies can temporarily exceed that target.

The browser has one `getCachedMesh`/`putCachedMesh` API for full and LOD geometry. Disposable IndexedDB schema 8 separates geometry from small usage records. Memory retention is 32 MiB/64 entries; disk retention is 192 MiB/1,000 entries. Writes have a 32 MiB/32-operation admission bound. Opening and reading have 150 ms deadlines, and write transactions have a 1-second deadline. Storage failures become cache misses or discarded writes. Both request and transaction failures are observed, including deadline aborts. Cache work never holds a Worker slot.

Transient resolve/body failures retry with exponential backoff from 250 ms to 30 seconds, preserving displayed meshes. Absent chunks and integrity errors remain distinct. Queued reads stay retryable until a request actually starts. Worker errors, message decode errors and 30-second execution/decode stalls rebuild the pool, settle outstanding jobs and restore missing inputs. Disposal cancels requests and timers. Diagnostics expose retries, terminal errors, cache waits, estimated resident bytes, actual Worker loads, restart count and cumulative dispatch/application counts.

## Repeatable real-world check

Build and start a server with the intended source world and assets. The benchmark never writes the source world. Use the same world, position, browser GPU and viewport for comparisons:

```sh
pnpm build
pnpm bench:loading --url http://127.0.0.1:3300 --world WORLD --seconds 600 --faults --out LOCAL_loading_acceptance
pnpm bench:loading --url http://127.0.0.1:3300 --world WORLD --seconds 120 --cache off --out LOCAL_loading_no_cache
```

The isolated browser retains the default perspective, view distance 8, additional LOD distance 12 and medium scheduler profile. It waits up to 150 seconds for initial convergence, then observes the full requested stationary duration. Coordinates default to `-28.3,79.4,-25.1`, yaw `155.7` and pitch `-9.8` degrees; override with `--x`, `--y`, `--z`, `--yaw`, `--pitch`. Windows defaults to ANGLE D3D11. `--gpu default` and `--gpu software` select other test environments explicitly.

With `--faults`, it injects resolve HTTP 503, short delivery leases, delayed downloads, body HTTP 409/503, a Worker error, a missing Worker response after moving, and actual WebGL context loss/restoration. It rotates the view by 180 degrees, moves 96 blocks and returns to the original position after Worker recovery. These are browser-side injections; they do not restart the source server or simulate a real S3 provider outage.

Success requires visible terrain, no terminal errors, no pending retries/cache waits/Worker work, bounded tracking, and no growth in chunk dispatches, mesh requests, mesh applications or retries during the stationary interval. Worker faults must rebuild the pool and settle again. Injected failures and retryable resource admission/lease rejections may recover; other HTTP failures, browser errors or console errors fail the run. The script closes its isolated browser even on failure; the operator remains responsible for stopping the test server.

`report.json`, live samples, diagnostic snapshots and before/after screenshots are written beneath `--out`. Keep these ignored local artifacts when diagnosing a failure. Check context-restored screenshots as well as the counters. Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm boundary:check`, `pnpm test:frontend`, `pnpm test:transparency` and `pnpm test:overlays` for the matching automated coverage. Small synthetic rendering acceptance checks correctness and ownership; it does not establish large-world GPU throughput.

Network totals count encoded HTTP response bodies separately from the viewer's decoded NBT counter. Artifact totals recognize the server resource and public CAS URL layouts; custom CDN layouts remain included in overall totals. `--profile` saves a Chromium CPU profile and performance metrics for the stationary interval. Profiling adds measurement overhead; CPU samples are not GPU timings or a frame-rate guarantee.

Use `--compare PATH/TO/stationary-final.json` on the opposite cache policy to compare the full-detail chunk set and geometry byte counts at the same position and render identity. A complete neighborhood cache key requires all known inputs to be resident before generation; partial first-display geometry cannot enter that cache. Mesh render key version 19 invalidates previously generated partial-neighborhood entries.

## Verified real-world run (2026-10-22)

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
