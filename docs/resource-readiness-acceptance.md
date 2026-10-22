# Resource readiness and remaining loading fixes

Date: 2026-10-23 (Asia/Tokyo). Branch: `codex/resource-readiness-and-lifetimes`, primary worktree. Base: `13dd5062ba741ce514213a57bcf7c0bb9a429568`. Validation host: Windows x64, Node 26.8.1, pnpm 12.14.0; production reader containers also exercise Node 24. No deployment or production bucket writes were performed.

## Implemented behavior

- `resources.publication.start()` and the authenticated readiness HTTP API own one bounded online publication task. They use the existing full-closure generation, CAS upload, anonymous verification and expected-parent commit. Only a completed task returns a public head and existing resource references. Client disconnects do not cancel the server-owned task; shutdown cancels future work and drains started backend operations.
- Startup warmup is optional and defaults to manual. It cannot bypass durable `requiresSourceSnapshot` state. Pure public readers remain source-free and read-only. No lazy public miss generation, partial publication or second delivery protocol was introduced.
- Publication preparation coalesces identical intents before snapshot admission. A separate one-task gate prevents queued publishers from consuming render-root generator slots. A stale expected parent is a failure in both task and publication status.
- Resolve callers own cancellation independently. The last owner aborts shared work, while retiring tasks retain their task/memory charges until settlement. Transferred preparation reservations belong to the actual shared materializer. Orphaned output leases are released once. Publisher body reads also cancel while waiting for work memory.
- Resolve has a 25-second deadline and renews handoff availability when the entire batch is ready. An expired intermediate promise fails explicitly. Body membership uses an index charged to the existing member lifetime; canceled neighbors cannot remove a surviving caller's member.
- Immutable publication manifests/pages and their lookup indexes have bounded retention. Authority/retention checks still precede use. Overlay resource resolution uses batches of up to 128 selectors.
- Top-map dependency metadata is reused only with reliable unchanged revisions. Weak terrain validators bypass retention; changes during validation fail explicitly. Region revisions include effective terrain overrides/additions and exclude entity-only changes. Tile bodies are still read and verified. Cold dependency preparation batches two columns; concurrent source readers share bounded layout probes while preserving independent region failures.
- Render-root atlas preparation reuses its admitted bundle/block artifacts. Game-data reads have an 8 MiB input limit, bounded reads, post-read revision checks and strict UTF-8 decoding. World navigation releases browser head ownership and prevents late refreshes from restoring released worlds.

The API, configuration and source-free reader contract are documented in [resources](resources.md#online-preparation-and-public-links) and [server configuration](server-configuration.md).

## Re-audit: cancellation, budgets and visibility

The re-audit reproduced a producer-pin race: a fast caller without a signal could release its result before a coalesced signal-owning caller acquired its independent lease. Each waiter now acquires ownership inside shared delivery, before caller continuations run. The producer releases its pin only after every waiter has acquired or left. Repository preparation/materialization and generator entries use the same ownership boundary. The regression repeats mixed waiter paths 40 times with zero optional retention and verifies complete lease release.

Member metadata now stays owned until the complete resolve batch settles. A slow sibling, an independently renewed body pin and a later metadata sweep cannot remove an early batch member. Failed batches still await admitted workers before releasing their members. Cancellation checks, bounded waiter counts and retiring task/memory charges remain in place; cancellation does not pretend to stop uninterruptible IO.

Resolve observation/view lookup now uses the existing bounded Singleflight coordinator as well. Canceling a caller during an authoritative publication read detaches it immediately without canceling a surviving owner; an uninterruptible read keeps its coordination slot until settlement and shutdown drains it. The regression blocks the control-store read: the old path fails its one-second cancellation bound, while the corrected path cancels promptly and the other caller still resolves successfully. Deadline errors from this phase use the same retryable resource error as generation.

Dependency revision probes now have a 16-operation admission limit before inventory/stat work begins. A seventeenth probe fails without touching the source. Immutable document caches use conservative weights including their lazy indexes; they do not cache authority/retention decisions. Work and handoff memory remain separately charged, and preparation transfers its reservation to the actual shared materializer until settlement. The bounded online task retains one intent/result within its existing metadata allocation, with no publication backlog.

Automatic reconciliation waits for foreground preparation and rechecks the source-snapshot requirement after entering the source write barrier. Failure markers are written within that same barrier, so an asynchronous failure tail cannot overwrite a later durable `requiresSourceSnapshot` marker. Notifications received during a build schedule another reconciliation. Shutdown drains that reconciliation as well as foreground work.

The conditional head write is the publication visibility boundary. Source/cancellation validation runs after closure verification and immediately before the head CAS, including the stable-publication no-op path. Cancellation during final verification or retention writes preserves the old head. Once the CAS starts, its storage outcome is authoritative; cancellation cannot roll back a completed commit. Prepared metadata may remain recoverable, under the existing explicit quiesced recovery rules. Link projection checks shutdown after its asynchronous work, so it cannot report a newly ready task after cancellation; a previously committed head remains authoritative.

Regression fixtures cover all of these interleavings, plus an already canceled reviewed publication that must perform no new source preparation. No public partial closure, lazy public-miss generation, alternate delivery protocol, expiring writer takeover, hidden artifact cache, renderer quality reduction or pure-reader write capability was introduced.

Only pending readiness tasks coalesce. Reusing a completed stable task by its parameters could suppress a later source change with the same expected parent. Starting a new request now always revalidates the frozen source after the previous task finishes; retained terminal status remains available until replacement/expiry. A regression first completes a stable no-op, changes the source root, then repeats the same request and verifies a new committed head and matching public result.

## Regression evidence

Counts overlap and must not be added.

| Check | Result |
| --- | --- |
| Final workspace `pnpm test`, with a temporary PostgreSQL 17 database | 442 passed, 0 failed, 0 skipped; container removed |
| Final targeted lifetime/publication/readiness regressions | 65 passed, including terminal-task and view-lookup regressions reproduced against their old implementations |
| Production artifact isolation/startup | 2 passed |
| Frontend acceptance | 4 passed |
| Final online resource browser acceptance | 2 passed; four real families, five direct readiness references, verified bytes and no application body requests |
| Rebuilt production containers | 2 passed, including a read-only root with zero optional retention |
| Real local MinIO | 1 passed: online upload, chunk/atlas/bundle/game-data/media links, anonymous integrity/CORS and a separately restricted reader identity/container |
| Overlay WebGL; transparency WebGL | 1 + 1 passed |
| Release/restore/rollback | 3 passed; 1 real AWS/R2 environment test skipped because its environment file was not supplied |
| Typecheck, lint, boundaries, version consistency, formatting, whitespace, build | Passed |

New regressions include independent cancellation, producer/waiter ownership races, retiring-task replacement, abandoned lease disposal, shared materializer memory accounting, canceled publisher work admission, final handoff renewal/expiry, active batch membership during sweeping, reliable/weak dependency revisions, pre-probe admission, immutable/budgeted publication documents, oversized/invalid-UTF-8 game data, more than 16 historical world navigations, active-world limits, released refreshes, expected-head conflicts, task coalescing with one generator slot, authenticated task polling, disconnect independence, source-marker ordering, cancellation before head visibility and draining anonymous verification during shutdown.

Raw local test logs are under `artifacts/resource-acceptance/*.log` (ignored by Git). Tests use temporary roots and temporary backend containers. Production AWS/R2/CDN behavior was not inferred from MinIO.

The initial visual rerun overlapped a build that cleans `dist`, causing missing-artifact failures. Those runs are not counted as passing evidence; visual checks were rerun after the build. The earlier default-environment workspace run passed 429 tests with four PostgreSQL groups skipped; the final PostgreSQL-enabled run above includes every added regression and database group.

Code commits by responsibility: `c45b61b` (shared resource lifetimes and admission), `57df28b` (engine/publication coordination and visibility), `2a39104` (source/dependency reads), `0d67261` (readiness API/configuration and integration coverage), `b66ed2e` (browser world ownership), `15c73bc` (terminal readiness revalidation), `5d9a2a3` (independent view-lookup cancellation). Documentation and fresh benchmark evidence follow in a separate commit.

## Performance evidence

The deterministic path microbenchmark preserves the exact terrain digest `44b71f2293ef3182ca5720387bde4e2b5800383e965181ba9af507fc04e3015e`. Its scope is dependency preparation and immutable document reads, not complete tile/network latency. The before run was captured on the clean base before implementation. Final values use the median of three independent processes, each with 5 warmups and 30 measured rounds. Final reports include a source fingerprint; provisional reports are retained separately.

| Path | Before | Final median / operation evidence |
| --- | --- | --- |
| Cold terrain dependency P50 / P95 | 2.717 / 3.159 ms | 2.603 / 3.554 ms; source calls 1024 → 512 per validation |
| Cold terrain dependency CPU per request | 3633 µs | 3633 µs; Windows CPU sampling is coarse |
| Repeated immutable manifest P95, 512 entries / 145533 bytes | 7.524 ms | 0.0071 ms; backend reads 35 → 1 over warmups plus measured rounds |
| Reliable unchanged terrain dependency P95 | Full validation on each request | 0.0081 ms for the memo itself; one initial 512-call validation, no further terrain reads |

The memo timing excludes authoritative revision lookup and tile-body IO. Tiny CPU samples recorded as zero are below the measurement resolution, not evidence of zero CPU use. The cold microbenchmark's median P95 is about 12.5% higher than the earlier baseline, despite fewer source calls, a lower P50 and unchanged sampled CPU; it does not establish a universal latency improvement. The original measurements are retained, rather than replacing a slower result with a favorable rerun. The real baked-tile regression additionally proves that an unchanged second read performs zero NBT/MCA body reads, while corrupted tile bytes and changed terrain/environment still fail. The microbenchmark source fingerprint is `9af72e819d146e20c0599dd05f60fdd9ca7aed83ddfb06033d7e0a6c32e3be15`.

Reports: `artifacts/resource-acceptance/resource-paths-before.json`, `resource-paths-after.json`, `resource-paths-after-2.json`, `resource-paths-after-3.json`. Reproduce with `pnpm exec tsx --no-cache --conditions=development scripts/bench/resource-paths.ts <output.json>`.

The complete fixed-fixture capacity sweep comprises **76 closed-loop cases + 152 offered-load cases, 3 independent processes each (684 measured runs, plus calibration)**. Scan, hot, edit and resolve→GET traces cover all nine capacities and 50%/80% offered load. This is a repository/handoff/GET benchmark with immutable prepared inputs, not an end-to-end renderer/network measurement.

The first complete re-audit sweep failed its unchanged **1.10** thresholds: scan P95/CPU ratios at capacity 262145 were **1.20675/1.13720**, and P95 at capacity 1048576 was **1.12276**. Every offered-load case was stable. That failure is preserved in `artifacts/resource-acceptance/capacity-audit-failed.json`; it must not be read as passing evidence.

An interleaved diagnostic then compared capacities 262144, 262145 and 1048576 with adjacent zero-retention baselines, alternating order across three independent pairs per capacity. It used the original warmups, requests, workers and thresholds. All three passed; worst P95/CPU ratios were **1.03674/1.03081**. Their cache behavior counters agree across the neighboring capacity boundary. The evidence suggests measurement-period drift, rather than a demonstrated capacity-specific algorithm regression; this is an inference, not proof that the first failure can be ignored. Raw pairs are in `artifacts/resource-acceptance/capacity-paired-audit.json`. Reproduce with `node scripts/bench/resource-capacity-pairs.mjs` after a complete sweep.

The measured repository/handoff source fingerprint is `e7505389734b679521a284c647d23d2f50b369950d76ee62a1645bc1559dbf28`. The runner verifies that fingerprint before and after each complete run. No fixture or acceptance threshold was relaxed. Publisher task coalescing is outside this fixture's measured path and has separate regression coverage. Full sweeps and the interleaved diagnostic run without simultaneous builds or test suites.

The complete recheck fixes CPU affinity to mask `0x4` (one logical CPU) for the benchmark PowerShell process and its child workers, reducing cross-core scheduling variation. It restores the original mask afterward and does not change system-wide settings. The ordinary default-affinity failure remains part of the evidence; a controlled run cannot establish that every default-affinity execution will pass. Reproduce the controlled run in PowerShell with:

```powershell
$benchProcess = [Diagnostics.Process]::GetCurrentProcess()
$originalAffinity = $benchProcess.ProcessorAffinity
try {
  $benchProcess.ProcessorAffinity = [IntPtr]4
  pnpm bench:resources
} finally {
  $benchProcess.ProcessorAffinity = $originalAffinity
}
```

That controlled complete sweep **passed**: worst low-benefit P95/CPU ratios were **1.03922/1.02104**, with **zero unstable offered-load cases**. All 684 measured samples ended with **zero work and handoff bytes**. `artifacts/resource-acceptance/capacity-benchmark.json` contains the samples, source fingerprint and `auditExecution` affinity metadata. The benchmarked source remained unchanged throughout; final view-lookup cancellation and publication task guards are outside this fixture and were regressed separately. This passes the controlled environment's thresholds, while the failed default-affinity run and slower cold-path microbenchmark remain explicit limitations.
