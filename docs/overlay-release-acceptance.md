# Overlay release acceptance and recovery

The `0.2.0` development release completes phases 1–7. Package metadata advances together under the workspace 0.x policy; content documents and snapshot manifests retain their independent schema version 1, and the HTTP capabilities protocol remains 1. This does not publish npm packages or create a Git tag. The `0.3.0` follow-up removes the world-storage APIs deprecated in `0.2.0`; use object-storage names and `services.mounts.worlds` (the distinct remote `ServerWorldStorage` protocol remains supported). No user-database migration is introduced by overlays.

## Reproduce the gate

Use Node 24+, pnpm, a local Docker engine and Playwright Chromium (installed Google Chrome is the macOS default). The ordinary checks do not need a hosted database. To include PostgreSQL cases, point `TEST_DATABASE_URL` at a disposable local PostgreSQL instance with permission to create/drop isolated test databases. Tests never use `DATABASE_URL` as a substitute.

```sh
pnpm typecheck
pnpm version:check
pnpm boundary:check
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm --filter @violet-map/server db:check
pnpm --filter @violet-map/cli test:artifact
pnpm --filter @violet-map/server test:db:artifact
pnpm test:production
pnpm test:release
pnpm test:containers
pnpm test:frontend
pnpm test:overlays
```

`test:release` builds the pre-overlay Git revision `781bff4` (override with `VIOLET_ROLLBACK_REF`) from an archive, installs its pinned dependencies, and deploys old/current production artifacts into temporary directories. Keep that Git history available; CI checks out full history. It starts actual child processes from an unrelated working directory, without source/runtime dependency shortcuts. Public registry package downloads may be needed when the old lockfile is not cached.

The optional real-S3 case uses an existing bucket and a fresh `violet-map/acceptance/<UUID>/` prefix, then verifies removal of that prefix. Supply a private file with `S3_API_ENDPOINT`, `S3_BUCKET_NAME`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`; its values never appear in test reports. Local command:

```sh
VIOLET_ACCEPTANCE_ENV_FILE=LOCAL_railway_deploy/.env pnpm test:release
```

Without that file only the real-S3 case is skipped. No new bucket, hosted database or other remote service is provisioned. Optional PostgreSQL cases skip only when `TEST_DATABASE_URL` is absent. The explicit OS keychain test remains opt-in and unrelated to overlay deployment; it requires an unlocked user credential store.

Results on 2026-10-17: all 135 regression tests passed with local PostgreSQL; CLI artifact (1), database artifact (1), production (2), container (1), frontend (1), release/recovery (4, including real R2 and configuration examples) and WebGL (1) acceptance passed. The real R2 case reused the existing bucket under an isolated prefix; production content was not used as test data. No acceptance service required an additional remote resource.

## Compatibility evidence

| Combination | Evidence |
| --- | --- |
| Old configuration / new server | Configuration and mount normalization tests retain worlds, resource paths, auth and existing S3 prefix meaning; API/CLI tests retain original world HTTP routes. |
| Named one-root / two-root / mixed storage | Mount tests exercise local isolation/overlap/lazy creation; release snapshots restore across distinct local roots and real R2-to-local metadata/blob mounts while worlds remain in R2. |
| Old client / new server | Built pre-overlay CLI performs an actual identity-checked world sync against the current production artifact; external metadata/blob digests stay unchanged. |
| New viewer / old capability contract | Built `/map/` viewer ignores absent content flags and makes no overlay/media/GLB requests; the world canvas still initializes. |
| Public/sync with content reads | Feature tests use database factories that fail if invoked; static content writes, public reads and independent diagnostics run without a user DB. Production/containers separately cover full user mode. |
| Static prefixes / independent API | Production viewer at `/map/`, admin at `/console/` and API under `/violet/`; images and deferred GLB display, Range, ETag, CORS and token isolation are checked. |
| Delete/sync isolation | World deletion leaves content/blobs intact; old-world synchronization retains registration and all content/blob hashes. Deleted-world registrations restore with source status `missing`. |
| Content failure | Invalid documents return `CORRUPT_CONTENT`; backend failure returns 503 without backend details; independent world listing remains available. Viewer errors identify the affected feature while other curves/terrain continue. |

## Fixed first-release budgets

`packages/web/src/render/overlayLimits.ts` is authoritative for the web viewer. These are explicit display limits, not format truncation or promises about arbitrary devices/models:

| Resource | Limit / behavior |
| --- | --- |
| Visible features | 512 in stable binding/feature order; additional candidates are suppressed and reported. |
| Curves | 65,536 points each; 200,000 points total; subdivision depth 18; target 0.5 CSS-pixel hull error. Caps produce coarser chords or a feature error if insufficient points remain. |
| Region atlas | 4096 per side or GPU maximum; RGBA up to 64 MiB; large spans lower resolution and report the cap. |
| Media | 32 owned versions, 4 concurrent loads, 128 MiB estimated shared geometry/texture storage; last owner disposes immediately. |
| Download / bitmap | 64 MiB per source; 4096 texture side or GPU maximum. Server format limits also apply. |
| Resource churn | Offscreen/disabled content has zero active features, media bytes and mask bytes; five GC-assisted load/unload cycles must return renderer counts to the same baseline. Retained JS heap growth tolerance is 2 MiB for this fixture. |

The production build runs one fixed 180-frame camera path: orthographic sweep, perspective sweep, leave the scene, return. It records CPU submission time, frame intervals, load/path requests, peak heap/media/mask/curve resources and checkpoints. Disabled content makes zero content requests and has zero active curve points; offscreen media and masks are released. Actual delayed network requests are canceled on context changes. See [rendering measurements](overlay-rendering-validation.md) for numbers and reviewed reference images.

On the documented M3/Chrome reference machine, `VIOLET_REFERENCE_PERF=1 pnpm test:overlays` additionally enforces p95 render CPU envelopes of 2/6/12 ms for baseline/typical/pressure and a 34 ms frame-interval p95 envelope. These regression envelopes are reference-machine checks, not portable FPS guarantees. Other machines still enforce all resource, lifecycle and rendering assertions. Complex GLB content, driver overhead and decode peaks are not represented by the small reference cube. Player transparency uses approximate sorted blending; intersecting water/walls are not order-independent.

## Backup and restore

Use [one root](../examples/overlays-one-root.yaml) or [two roots](../examples/overlays-two-roots.yaml) as complete configurations. Paths are relative to the YAML file. Set the static admin token through the environment. Keep the original worlds mount/archives, private credentials and configuration separately. Run a single content writer; there is no distributed writer lock.

Stop every API/content writer and any direct world/data/diagnostic uploader before snapshotting. Keep writers stopped through restore and verification. `--quiesced` declares that operational precondition; it does not stop processes or provide a distributed transaction. The script never initializes a user DB.

```sh
pnpm build
node scripts/operations/content-snapshot.mjs backup \
  --config /srv/violet/current.yaml --output /backups/violet-2026-10-17 \
  --env-file /secure/violet.env --quiesced
node scripts/operations/content-snapshot.mjs restore \
  --config /srv/violet/restored.yaml --input /backups/violet-2026-10-17 \
  --env-file /secure/violet.env --quiesced
```

The backup contains every object in `content` and `blobs`, including immutable retained revisions, heads/tombstones, media, diagnostic uploads, data overrides and unreferenced objects. It validates content references and referenced blob digests and records map registrations, relative `worldKey`, archive identities and physical mount locations without credential values. The world archive is separate; it is not silently copied into this snapshot. Files are SHA-256 addressed to support both a same-name object and its directory descendants. New directories are private (0700), files 0600; existing backups are never overwritten. The complete manifest is written last; incomplete directories cannot be restored. Quiesced source inventory changes abort the operation.

Restore verifies all object sizes/checksums and metadata closure before any target write. It rejects unsafe/duplicate keys, external symlink objects, nonempty content/blob targets and a different previously identified archive. Select fresh logical mount destinations in the target config. Blobs and immutable revisions precede publication heads/maps, followed by checksum verification. Partial failed targets are not automatically deleted or overwritten; retain the backup and retry at fresh locations after resolving the failure. Preserve the relative worldKey and original archive identity; use explicit API rebinding if the world identity is intentionally changing. Originally missing/unverified world sources retain their metadata and can remain unavailable until the correct world is restored.

The Railway full/incremental scripts remove/cancel the old deployment and wait for the drain window, then create a verified private `LOCAL_railway_deploy/backups/<timestamp>/` snapshot before world synchronization or source upload. `deployment.json` and the backup's `recovery.json` retain the previous verified deployment/commit and selected service/environment. No credentials enter the uploaded source. A failed backup stops deployment; no automatic backup deletion or GC occurs. Copy private backups off the workstation according to your operational retention policy.

## Paired rollback drill

The automated drill actually performed this sequence:

1. Seed a world identity, a pinned SVG asset, two retained layer revisions and a bound map; close the writer and snapshot metadata/blobs.
2. Start the relocated current artifact with `CONTENT_WRITES_ENABLED=false` and `CONTENT_READS_ENABLED=false`. World listing, bundled resource packs and existing APIs continue; overlay routes return 404.
3. Stop it and start the pre-overlay artifact from `781bff4` with a separate legacy configuration pointing at the same physical worlds directory. Confirm capabilities, worlds and data. External content/blob hashes remain unchanged.
4. Restore the snapshot into fresh metadata/blob locations, restart the current artifact, and confirm the same map/archive, layer revision 2 and pinned media. Run the built old CLI against it to synchronize an additional world file. No user DB is created and unrelated cwd remains empty.

For an operational binary rollback, stop the API first, retain its artifact/dependencies, config and private environment, and pair the old artifact with [legacy configuration](../examples/overlays-legacy.yaml). Point `worldsDir` at the actual current worlds location. For legacy S3 use the original `WORLD_STORAGE=s3`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_PREFIX`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` settings; the prefix must identify the worlds mount, not content/blobs. Remove the new named-backend/mount and content-feature settings from that rollback environment/YAML. An old binary rejects new YAML fields; swapping only the executable is insufficient.

```sh
# With the rollback-only environment loaded, and all writers stopped:
VIOLET_MAP_CONFIG=/srv/violet/legacy.yaml node /srv/violet-api-old/dist/src/index.js
```

Keep content/blobs byte-for-byte; the old binary ignores them rather than rewriting/deleting their schema. The architecture never required moving worlds. If you moved them separately, the rollback config must point to that real location. Do not revert an unrelated user database; overlays introduce no user-table changes. To move forward, stop the old process, select the current artifact/config and retained mounts (or restore a verified snapshot), and recheck world identities, manifest/media and diagnostics before resuming writers.

This drill ran in isolated local artifacts and temporary R2 prefixes, not by replacing the production service with the historical binary. The Railway service receives the verified current branch through the incremental deployment script and keeps Serverless, one replica and the same project/service/domain.
