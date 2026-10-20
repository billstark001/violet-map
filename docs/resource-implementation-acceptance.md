# Unified resource implementation and acceptance

Date: 2026-10-21 (Asia/Tokyo). Branch: `feature/unified-resource-cache-public-delivery` in the primary checkout. Baseline: `da048f422e155861f153088e2a73ad4ac0d3fce2`. No deployment, cloud bucket configuration or production uploads were performed.

## Takeover audit

The interrupted checkout already contained substantial P1–P7 code, beyond the plan's old progress note. It was preserved and audited. Initial checks found one failing media error-contract test, lint errors and unformatted source. The initial capacity benchmark measured cache operations rather than repository delivery and did not execute the configured offered loads; the initial browser test used synthetic three-byte objects rather than actual resource formats.

The takeover fixed these implementation defects:

- Zero-retention handoff ownership could disappear between a hit and issuing a second client's reference. Producer/caller reservations now precede promise completion; client transfers and publisher reads consume their own reservations. An interleaved 100-reader regression covers this race.
- Preparation accumulated unclaimed bodies. Prepared descriptors now release operation-owned bytes as they advance; publication reads preserve viewer promises. Work, handoff, queued work, optional fill and metadata remain separate bounds. Combined publisher/serve roles share one work allocator for repository and control reads. A bounded, cancellable work queue admits generation after active transfers drain; oversized work is refused before preparation.
- View batches could finish after source invalidation. Server batches check their generation, reject selectors outside a world-scoped view and release issued pins on failure. Browser refresh commits all world/render heads together, retains the previous complete set on failure and rejects bodies arriving from older views. Metadata projections carry the selected view ID.
- Top-map dependencies omitted current dimension skylight checks. Terrain, packs/data and lighting now invalidate baked freshness explicitly. The coordinate lookup is guarded by artifact digest; replaced downloads are aborted and old GPU resources disposed.
- Asset/data business reads bypassed the repository; an unused atlas build entry retained separate task handling. Business bodies now use the common repository/HTTP implementation, and the unused atlas entry was removed.
- Public object existence checks could use a stale metadata TTL during publication/GC. Authoritative resource mounts use fresh probes. Conditional control-document readers enforce size limits before accumulating arbitrary bodies. S3 transport has explicit connection/request/socket deadlines.
- Selected local/SQLite/workspace failures could strand an acquired cache owner. Initialization and shutdown release components in dependency order; selected-driver failures never select another driver. Explicit offline reindex can rebuild the disposable SQLite index.
- Content mutation responses lacked the promised publication status, and CORS did not expose those headers. Successful commits now report their business revision and publication state; CLI/admin show committed versus pending/failed publication separately.
- Offline resource commands could compete with a running writer. Management now defaults to the online API writer; local modifications require explicit quiescence. Controlled source changes require an explicit completed source snapshot before a content debounce can publish them. Pending state and restart reconciliation survive in the authority store.

## Reviewable commit boundaries

The original aggregate commit `cf71202` was split into twelve commits: shared contracts, storage adapters, bounded repository/persistence, generators and CLI bake reuse, publication/GC, browser downloads, the coordinated application protocol switch, CLI management, backend/operations acceptance, benchmark implementation, benchmark evidence, and release documentation/verification. The protocol producer and consumers switch together. Additive library steps precede that switch; no intermediate compatibility layer was introduced. Four checkpoints (shared contracts, repository, publication and application cutover) were independently archived and verified with frozen dependency installation, workspace type checking and package boundary checks. The final implementation is byte-for-byte identical to the original aggregate commit; only verification records and documentation changed after the PostgreSQL run.

## Stage ownership and completion evidence

| Stage | Implementation owner | Acceptance evidence |
| --- | --- | --- |
| P0: contract/baseline | core resource contracts, `scripts/bench/resources-fixture.json`, this report | Frozen 1.10 low-benefit P95/CPU limits; same-protocol zero reference plus independent original/current handler comparison; explicit role/persistence contracts |
| P1: shared infrastructure | storage CAS/capabilities; resources repository, budgets, cache, catalogs, invalidation | Zero retention, oversized objects, 100-way coalescing, interleaved GET ownership, shrink/drain, queue admission, explicit SQLite/corruption, local conditional CAS, Node 24 and read-only-root checks |
| P2: media | server content business service; common repository and HTTP helper | Original deduplication, retained versions, authorization/If-Match, bound reads and Range; shared publication/GC tests protect originals |
| P3: assets | resources asset pack; engine render root | Deterministic atlas PNG/document, animation regression, pack precedence, shared action/body reuse and no temporary atlas image route |
| P4: chunks | resources world source and chunk artifact; region pages | Existing override/MCA/entity/negative-coordinate regressions; deterministic MessagePack; generation guards and region closure publication |
| P5: top maps | resources top-map dependencies/source/bake; CLI render hooks; web manager | Effective override baking, unchanged skip, terrain/pack/skylight invalidation, v6 payload validation and version-guarded downloads |
| P6: publication | resources publication store, public target, GC; CLI | Expected-head CAS; stable publication generates/uploads/writes no new control objects; crash injection at writer/prepared/manifest/retention/head/cleanup; explicit recovery and backup pins; local, HTTP CAS and real MinIO |
| P7: coordinated switch | core capabilities/overlay parsers; viewer/admin/CLI | Protocol 2 only; strict single URL; no credential leakage or API-body fallback on public errors; actual four-family browser delivery and pose-only edit with zero body generation/upload |
| P8: release preparation | manifests/lockfile, docs/examples, Docker/backup/deploy tooling | 0.4.0 workspace, production/CLI/database/resource artifacts, independent images, role examples, recovery inspection and reviewed-revision local deployment preparation; deployment remains unexecuted |

## Test results

Final verification used rebuilt production artifacts. All executed suites finished with zero failures. Counts overlap across suites and must not be added together.

| Command / environment | Result |
| --- | --- |
| `pnpm install --frozen-lockfile`, `version:check`, `boundary:check`, `typecheck`, `lint`, `build`, `format:check`; `git diff --check` | Passed; coordinated 0.4.0 manifests and package boundaries |
| `TEST_DATABASE_URL=<local test URL> pnpm test` | 282 passed, zero failures or skips, using local PostgreSQL 17.11 |
| `pnpm test:resources` / `pnpm test:resources:roles` | 62 / 3 passed |
| Node 24.22.0: resources, storage and role suites | 65 passed, including explicit SQLite selection |
| Node 24.22.0: database/CLI/API/authorization suites with local PostgreSQL 17.11 | 24 passed, zero skips; migration initialization/adoption/rollback/history/locking included |
| `pnpm test:production` | 2 passed |
| CLI artifact / server database artifact / resources artifact | 1 / 1 / 1 passed |
| `pnpm test:frontend` / `pnpm test:overlays` / `pnpm test:transparency` | 4 / 1 / 1 passed |
| `pnpm test:resources:browser` | 2 passed, including the real four-family fixture |
| `pnpm test:release` | 3 passed; one real AWS S3/R2 test skipped because no supplier test environment was selected |
| `pnpm test:containers` / `pnpm test:resources:backends` | 2 / 1 passed; Docker read-only root and local real MinIO with a restricted reader |

The default memory artifact is checked with filesystem/SQLite imports forbidden. The earlier run without PostgreSQL is retained in `final-checks.json`; its four skips have now been exercised against the local instance. The remaining AWS/R2 skip is not recorded as a pass.

Role coverage is distributed intentionally: `resourceRoles.test.ts` instruments application filesystem writes and rejects unselected SQLite/source imports; `containers.test.mjs` verifies zero-retention dynamic operation with a read-only root and no writable mounts; `resources-backends.test.mjs` verifies a remote publisher/original store, a distinct S3 identity without write permission and a source-free read-only-root public container. The public closure exceeds the zero cache budget. Temporary workspace deletion/restart and selected-driver failures have dedicated checks. TSX's compiler cache is disabled in instrumented tests so framework writes cannot masquerade as application writes.

The four-family browser fixture uses generated MCA/override terrain, positive/negative regions, two dimensions, a generated texture pack, actual baked v6 top maps and retained PNG media. It validates MessagePack/image decoding and counts five direct public GETs (atlas document/image separately), with no API resource-body requests. Its pose-only edit changes the publication while generating and uploading zero resource bodies.

## Performance interpretation

[Original protocol comparison](../artifacts/resource-acceptance/original-baseline.json) archives the exact baseline revision into a temporary directory and installs its frozen dependencies offline. Three independent runs compare original cached single-chunk handlers, new zero-retention resolve/GET and the current retained resolve/GET path on identical frozen inputs. HTTP handler overhead is measured in-process; network latency is excluded. The original protocol is contextual evidence, not the 1.10 threshold reference. Additional integrity/protocol work can cost more than the original API.

[Capacity/load results](../artifacts/resource-acceptance/capacity-benchmark.json) use the actual repository/action-index/handoff/verified-read path with immutable prepared inputs. They scan byte boundaries around one object and the hot set; compare zero, LRU and the target policy; and run scan/hot/edit/resolve–GET traces at 50% and 80% of measured zero-retention throughput. Each point retains all three independent runs. P95/CPU and queue-growth decisions use medians; individual short-run outliers remain in the report. Offered-load calibration first certifies a stable zero-retention rate under the same scheduler, records every attempted rate, and derives 50%/80% from it. Target and zero-retention stability are acceptance gates; LRU stability remains a reported comparison. This measures memory retention, not a claim about production provider latency, CDN billing or a universal cache capacity threshold.

The final report passes all target-policy gates: 76 capacity/trace/strategy points, 152 offered-load points, three independent processes per point and six retained calibration attempts. Maximum gated P95 ratio is **1.093916** and CPU/request ratio **1.037334**, below the unchanged **1.10** limits. Zero-retention and target-policy offered-load points are stable. One LRU comparison (`edit`, 262144 bytes, 50% load) is unstable and remains visible in the report. The recorded implementation fingerprint matches the final benchmark dependency sources.

The original handler comparison records median P95 of 0.074375 ms for the original cached handler, 0.538166 ms for new zero retention and 0.134625 ms for new retained delivery. These values disclose the new protocol overhead; they do not establish a speedup over the old API.

Historical interrupted-agent microbenchmarks and the first failed full observation are preserved under `artifacts/resource-acceptance/history/`; they are not final acceptance evidence. In that first observation an isolated small-capacity P95 exceeded 1.10 and individual short load runs queued while concurrent acceptance work ran. A later complete run exposed a real admission-observation defect: generated cold digests were inserted without recording misses, so low-benefit fill pausing did not activate. The repository now observes and deduplicates those digests before retaining them, with a dedicated cold-scan regression. The final benchmark ran separately from concurrent acceptance work, without raising the P95/CPU thresholds, and checks a source fingerprint before/after the run.

## Deletion and preservation register

| Decision | Owner/evidence | Business basis |
| --- | --- | --- |
| Delete dual media `url`/`publicUrl`, media transport resolver/configuration and public-to-proxy fallback | core overlays, resource configuration, common browser downloader and strict rejection tests | One selected URL and one resource flow |
| Delete temporary `/api/assets/atlas/:key`, client atlas reconstruction and unused alternate atlas entry | assets route, resources asset pack, web atlas | Deterministic atlas document/image artifacts replace process-only addressing |
| Delete old capability inference and protocol parsing; update fixtures/versions together | core contracts, web/admin runtime, CLI artifact test | Matched 0.4 release protocol |
| Preserve fixed media IDs/version digests, retained/tombstone documents and If-Match | content/overlay tests, backup validation | Durable business identity, retention and concurrency |
| Preserve overrides, entity sidecars, negative coordinates and ordered pack precedence | shared world source/asset pack and regressions | Effective source semantics |
| Preserve genuine missing sprites | asset generator and missing selector result | Display behavior for genuinely absent assets; backend/corruption errors remain errors |
| Preserve protected source management and existing business reads | server routes and CLI regressions | Independent management/read contracts; bodies use the common implementation where replaced |
| Preserve documented runtime-config 404 behavior and static prefixes | deployment/runtime/browser tests | Standalone static hosting contract |
| Preserve documented unrelated configuration and rendering behavior | server configuration and render regressions | No unrelated compatibility rewrite |
| Preserve budget non-admission, explicit memory/local/SQLite selection, previous complete head after failed commit | resource/role/fault tests | Normal capacity policy and atomic visibility, never transport/driver fallback |

## Operational limits

- Real MinIO and local HTTP CAS were exercised. AWS S3/R2 production accounts, CDN cache rules/CORS changes and production latency/cost were not exercised or modified. Their configuration is documented separately; skipped supplier tests are not passes. Local PostgreSQL 17.11 was exercised with uniquely named databases created and dropped by the fixtures; the instance configuration was unchanged.
- A snapshot declaration requires a controlled/frozen source and an explicit end to external synchronization. Bounded mode observes mutable sources and does not publish. There is no distributed multiwriter lease.
- The original/media business store and authoritative publication objects are independent of all disposable caches. Private content snapshots verify publication/prepared/backup-pin control closures but exclude public copies and caches; a public-object backup needs its own durable pin and complete copy.
- The ignored `LOCAL_railway_deploy` scripts were inspected/updated locally for an exact reviewed revision and prepare/publish/verify. They are not distributed by this Git branch and were not executed.
