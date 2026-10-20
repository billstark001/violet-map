# Unified resource implementation and acceptance

Date: 2026-10-21 (Asia/Tokyo). Branch: `feature/unified-resource-cache-public-delivery` in the primary checkout. Baseline: `da048f422e155861f153088e2a73ad4ac0d3fce2`. No deployment, cloud bucket configuration or production uploads were performed.

## Second audit of the twelve commits

The independent follow-up audit reviewed the final tree at `c77c910a6feb5147b4b9edd176d8611bcbddb419` against the full October 19 plan, including its zero-capacity, optional persistence, role, package, publication and deletion contracts. That audit ended with uncommitted fixes in the same primary checkout. The user subsequently authorized the responsibility-scoped commits listed below, a separate formatting commit and pushing the current branch. The original twelve commits are preserved. The later sections record the previous implementation/acceptance run; this section records the corrected implementation.

| Commit | Audited responsibility and follow-up |
| --- | --- |
| `70ee708` | Browser-safe identities, strict resource references, canonical keys, source contracts. Retained the single current protocol. |
| `75cc4a3` | Object CAS, conditional operations, exact reads, local/S3/HTTP adapters and common URL encoding. Storage remains independent of generators. |
| `8f6e8d2` | Byte budgets, singleflight, handoff, memory/SQLite indexes and persistent caches. Fixed failed-write and concurrent-read catalog state. |
| `0e84bab` | Shared world/asset/top-map generators and CLI bake dependencies. Bounded asset JSON inputs, rejected corrupt declared MCA records, and removed obsolete CLI scanning helpers. |
| `25dee90` | Durable publication closure, writer recovery, retention and GC. Fixed configured retention reads and independently budgeted public verification. |
| `433882c` | Common browser downloader and atomic view refresh. Fixed first-world generation races and byte-length validation across cached/coalesced downloads. |
| `3938923` | Coordinated application protocol switch, role assembly, business authorization and source-free public projections. Fixed optional-driver activation, overlap validation and producer lease cleanup. |
| `26b18c7` | Resource CLI and explicit online/offline writer modes. Added complete prepared-manifest output/reviewed publication checks; disabled background reconciliation in offline commands. |
| `fd500ee` | Role/container/MinIO and backup acceptance. Rebuilt and reran with the corrected implementation; restricted reader and original-media boundaries remain enforced. |
| `1c63939` | Repository capacity/offered-load benchmark methodology and thresholds. No measured dependency source changed in this audit. |
| `740ce4c` | Benchmark evidence/history. Recomputed the recorded source fingerprint; all 76 capacity points and 152 load points still describe the measured implementation. |
| `c77c910` | 0.4 release/package/deployment documentation and prior PostgreSQL acceptance. Updated resource workflow documentation and recorded fresh acceptance below. |

### Findings fixed and regression coverage

- **Failed optional cache writes:** body/action catalog admission could survive a failed write. A concurrent reader could also observe an action before its write completed and remove its inventory entry. Pending entries are now hidden and failed admission rolls back without deleting uncertain or corrupt stored bytes. Failure injection verifies both retries and interleaved reads.
- **Producer leases:** render-root failure, failed resolve issuance, publisher materialization and body regeneration now release their generation leases on success and failure. Zero-retention tests include repeated GET reconstruction and repeated publication with zero remaining handoff/work bytes.
- **Optional persistence by capability:** content-only public reads no longer initialize derived cache directories, workspace or SQLite. Pure readers also avoid opening an unused shared cache. When explicit world/data capabilities activate generators, their local cache/index/workspace paths participate in the same physical overlap checks as the business mounts. Instrumented tests forbid all filesystem writes and SQLite imports in the content-only role and reject the corresponding active overlap.
- **Browser consistency:** first reads of a new world must agree with already selected render/world generations in both modes. JSON and atlas-document downloads recheck their captured view after transfer. Downloader cache/singleflight identity includes the declared byte length, so an inconsistent reference cannot inherit another caller's successful size check.
- **Publication retention and work:** old-head reads use the configured retention instead of a hardcoded seven-day limit. Public verification reserves bounded read/assembly memory before fetching, including when no dynamic repository exists. Bounded source observation uses the same work budget as generation.
- **Prepared CLI workflow:** `prepare` exposes the complete manifest and can save it with `--output`; `publish --prepared` validates that document, compares the current snapshot before any public uploads and compares the final closure before head commit. A source change fails with `SOURCE_SNAPSHOT_CHANGED` and preserves the committed head. CLI artifact tests exercise the API workflow without installing resources/server/storage/render. Offline commands explicitly suppress service background publication scheduling.
- **Source failures and allocation:** existing but truncated region headers, declared invalid terrain/entity records and disappearance during a known read are errors, rather than logical missing resources. Asset JSON file sizes and aggregate input are checked before allocation; failed builds can be explicitly retried after repair.
- **Responsibility/deletion cleanup:** removed the unused CLI JSON/PNG scanning chain and a redundant world-source forwarding function. Boundary checks now reject generator libraries in storage source/manifests and SQLite imports outside the explicit catalog sub-entry. No transport fallback, old resource parser, media URL alias or alternative driver was added.

Direct expected-parent publication remains necessary for the online writer reconciling committed business revisions. Prepared publication adds an explicit reviewed-input constraint to that same pipeline; it does not introduce another publisher or resource protocol. Existing binding/retained-media authorization, source precedence, genuine missing sprites, documented configuration and runtime-config 404 behavior retain the business bases in the register below.

### Follow-up acceptance

| Check | Result |
| --- | --- |
| Frozen install; version, boundary, type, lint, format and whitespace checks; workspace build | Passed |
| Full workspace tests with local PostgreSQL 17.11 | **294 passed, 0 failed, 0 skipped** |
| Node 24.19.0 resources/storage/role tests, including explicit SQLite | **74 passed, 0 failed, 0 skipped** |
| Production artifact tests; CLI, database and resources isolated artifacts | **2 + 1 + 1 + 1 passed** |
| Frontend; overlays; transparency | **4 + 1 + 1 passed** |
| Final four-family resource browser rerun | **2 passed** |
| Final rebuilt production containers; real local MinIO with distinct read-only identity | **2 + 1 passed** |
| Release acceptance | **3 passed; 1 real AWS/R2 environment test skipped** |
| Existing capacity report fingerprint | Exact match: `c54a3d6471822162cdb3802ade826ec3b991231338c06c42c4759e15106aed93` |

Test counts overlap and must not be added. The final browser and container reruns include the last source/allocation fixes. Benchmark policy/repository dependency sources were unchanged, so the existing full capacity sweep was fingerprint-verified rather than relabeling a new performance run. Production CDN, AWS/R2 credentials and supplier behavior remain untested. No deployment, production upload, commit or push was performed during this audit.

### Audit fix commit boundaries

| Commit | Responsibility and accompanying regression coverage |
| --- | --- |
| `a893857` | Cache admission and delivery leases; failed body/action writes, concurrent action reads and zero-retention reconstruction/publication. |
| `887c75a` | Bounded source preparation and package boundaries; oversized JSON, corrupt declared regions and forbidden generator/SQLite dependencies. Removes obsolete source helpers. |
| `efc2b4c` | Persistence activation and storage overlap checks; content-only public reader filesystem/driver isolation and explicitly enabled dynamic capabilities. |
| `76521b2` | Publication retention and public verification work; longer configured retention and rejection before fetching without a dynamic repository. |
| `3e8327e` | Browser view and byte-size consistency; initial mixed-generation heads and inconsistent cached/coalesced download references. |
| `0decf36` | Reviewed prepared publications and explicit offline writers; local manifest output, source drift before upload and API-only CLI artifact isolation. |

The split preserves the exact bytes of all 29 audited implementation, regression-test and workflow-document files. Post-split verification passed version/boundary/type/lint checks and **85 Node 24.19.0 targeted tests with zero failures or skips**. The audit record is committed separately. The final formatting checkpoint runs `pnpm format` across the workspace and has its own commit; a clean formatter result is recorded with an empty checkpoint commit. Deployment remains unexecuted.

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
