# Viewer responsibility boundaries

[Back to README](../README.md)

The viewer remains one package. Directory boundaries express ownership and are checked by `pnpm boundary:check`, including type-only imports, dynamic imports and browser globals in decision modules.

## Principles

1. **Scheduling owns decisions.** Camera demand, desired representation, quality guarantees, admission, priorities, dependency/repair promotion, dispatch, retry deadlines and residency victim selection belong in `packages/web/src/scheduling/`.
2. **Execution owns effects.** HTTP lifetimes, request generations, cache operations, Worker creation/messages/restarts, timers and applying decisions belong in `runtime/` and `resources/`. Device detection is an adapter; the resulting budget policy is pure.
3. **Display owns GPU objects.** A scene owns the textures, materials, geometry and Three.js objects it creates and releases them exactly once. It applies supplied quality eligibility and visibility information; it does not invent distance/quality promises.
4. **Contracts contain data.** `view/` contains immutable camera snapshots, spatial definitions, representation capabilities and mesh/display records. Decision modules never receive Three.js cameras, meshes, Workers, DOM objects or clocks.
5. **One owner per demand.** `ChunkScheduler` owns chunk demand records; `TopMapScheduler` owns tile demand records. Executors report actual resource/mesh state and never copy target quality, attention or priorities into their entries. A missing or expired demand cannot be recovered from executor metadata.
6. **One final Worker dispatcher.** Cache lookup and input preparation do not consume a Worker execution slot. Ready jobs return to `ChunkScheduler`, which rechecks current demand and entry identity, sorts current priorities and chooses Worker indices. Cache completion order and executor map iteration never determine execution order.
7. **Separate presentation, validity and residency.** Displayed geometry can remain visible during repair. Its presentation precision and content validity are different measurements. Releasing decoded Worker inputs does not discard completed geometry or create new demand.
8. **Share mechanisms without erasing strategy.** Chunk attention, tile distance/zoom and overlay layer order are different planners. They share explicit budgets and contracts while retaining their own quality and ordering rules. Network admission, decoded-input memory, cached bytes and GPU resources have separate lifetimes and limits.
9. **No compatibility paths or implicit recovery of old state.** Consumers import the owning module directly. Removed modules and exports have no forwarding files or aliases. Unknown LOD values fail explicitly; there is no fallback target derived from a stale displayed mesh or legacy entry fields.

Optional cache misses, transient transport retries, source lease renewal, absent source cells and Worker restart are explicit supported recovery operations. They preserve the selected source identity and current requested quality; they never switch delivery targets, render roots or old APIs.

## Ownership

| Owner | Responsibilities |
| --- | --- |
| `scheduling/chunkView.ts`, `cameraGridTracker.ts` | Camera attention, stable admission, promised full-detail disk, critical rays, desired full/LOD representation |
| `scheduling/chunkScheduler.ts` | Authoritative demand, IO work admission, current-priority mesh preparation and final Worker dispatch/acceptance |
| `scheduling/chunkPolicy.ts`, `chunkRetention.ts`, `chunkResidency.ts` | Quality predicates, retry policy, tracked-entry eviction and decoded-input/display retention selection |
| `scheduling/topMapPlanner.ts`, `topMapScheduler.ts` | Distance/zoom demand, online coverage, tile load/cancel/evict plans and late-completion quality |
| `scheduling/overlayPlanner.ts`, `overlayPolicy.ts` | Source/layer/feature eligibility, ordered activation, suppression and adaptive curve budgets |
| `scheduling/resourceBudget.ts`, `profiles.ts` | Hardware budget policy and user-selected throughput/attention tuning |
| `runtime/chunkRuntime.ts`, `chunkIo.ts` | IO/cache/Worker execution, request leases, dependency pins, health/restart, actual operation state |
| `runtime/topMapRuntime.ts` | Manifest/tile identity, requests, cancellation and applying tile plans through a display port |
| `runtime/overlayRuntime.ts`, `overlayMediaLoader.ts` | Overlay source/ETag/refresh lifetime and pinned media byte loading |
| `resources/` | Shared verified downloads, resource-view identity/renewal, mesh cache and reference-counted media resource pool |
| `render/chunkScene.ts`, `topMapScene.ts`, `overlayScene.ts` | GPU ownership, geometry replacement, clip/connectivity/frustum visibility and display feedback |
| `render/viewSnapshot.ts` | Three.js camera to immutable view-state conversion |
| `render/overlayMedia.ts` | Decode supplied bytes into display resources; never select or download another URL |
| `render/viewerEngine.ts` | Composition root, camera/control/environment setup and frame wiring; no terrain work queue |
| `worker/meshWorker.ts` | Execute full/LOD computation with the CPU-only render algorithms |
| `diagnostics/` | Observation and summaries; diagnostics do not affect demand, quality or dispatch |

The server's resource admission/publication budgets remain server-owned. A browser's camera demand cannot own another process's work queue or resource lifetime.

## Quality contracts

Every performance profile reserves enough tracked capacity for the entire configured full-detail disk. Completion, cache policy, low attention, neighbor satisfaction and resource pressure cannot downgrade that disk. Full and LOD dispatch use the same target predicate as result acceptance.

Transparency retains sixteen depth bins and the 3,145,728-pixel target cap (192 MiB before driver overhead). A scheduling or resource-budget change must preserve that rendering precision.

Terrain and Top Map use `render/staticMesh.ts` to declare that their geometry and world bounds stay fixed during a frame's render passes. The transparency renderer tests these meshes once against the frame's frustum before preparing materials and pass lists. Changes between frames still update normally; callbacks on these meshes may update uniforms but must preserve world bounds. General meshes retain Three.js culling on each pass. Temporary culling/material state and the original hierarchy are restored even if rendering throws. Frustum visibility remains entirely a display concern.

Surface-only representations cannot display a height slice below their generated/baked surface. The view contract exposes that capability: chunk scheduling requests full models for such views, and tile scheduling does not load an unusable Top Map representation. Section clipping and actual GPU visibility remain display operations.

Source absence, transient errors, pending work and completed empty geometry are distinct states. Context changes revoke request generations. Old responses cannot update a replacement entry, and old cleanup cannot release a newer request.

A Worker send failure revokes the rest of the dispatch plan for that pool. Cleanup releases execution slots and dependency pins before a replacement pool can consume a newly ranked plan. Static Top Map materials use a static shader and own no placeholder animation textures.

Each mesh job owns its execution phase, cache identity, dirty token and, once dispatched, its Worker index. Worker loads and active-task counts are observations of those jobs, with no parallel version registry or mutable counters. The entry records only its current pending version and scheduling-visible work flags. Finishing an obsolete job cannot clear a replacement's flags, and an unresolved cache lookup loses ownership when its job is revoked. Replies must match the assigned Worker as well as the task's version, chunk, kind and LOD step before releasing ownership.

Eviction plans include pending work and dependency pins. Tracked-entry eviction and decoded-input release share the same active-work predicate. The executor validates that precondition when applying an eviction; a violated precondition is an explicit error.

## Validation

Run `pnpm typecheck`, `pnpm boundary:check`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build`. Browser checks are `pnpm test:frontend`, `pnpm test:overlays` and `pnpm test:transparency`.

For real-world loading/recovery and retained full-detail geometry comparisons, follow [loading performance](loading-performance.md). External game installations and saves are read-only inputs: keep generated assets, runtime state, caches, baked maps, screenshots and reports in an explicit project test directory. Verification servers disable source mutation and publication and must be stopped after testing.
