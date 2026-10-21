# Unified resources (0.4)

The API, viewer, admin and CLI switch together to capabilities protocol 2 and overlay manifest 2. A resource has one URL and a SHA-256, exact byte length, MIME type and format. `server` and `public` are explicit modes. Errors never select another URL. Old media delivery settings, runtime capability inference and the temporary atlas image route have been removed.

`core` owns browser-safe contracts. `storage` owns object I/O, conditional writes, CAS and URL encoding. `resources` owns dependencies, generators, caching and publication lifetimes. Server and CLI assemble roles and expose operations. The browser uses one anonymous integrity downloader for chunks, atlas/texture images, top-map tiles and overlay media.

`ResourceGenerator` owns preparation and output leases; `ResourceViewSessions` owns identities and view retention; `ResourcePublisher` owns complete publication closures, reconciliation and GC. `ResourceEngine` coordinates reads and business projections. Publisher operations have one entry point, `resources.publication`; there are no engine-level publisher aliases.

Storage decorators preserve the backend's optional capabilities; service assembly selects them with `requireStorageCapabilities` before I/O. Publication authorities and persistent caches use `TransactionalObjectStorage`. Both HTTP adapters share range validation and bounded stream slicing with S3; requested lengths do not trigger allocations before bytes arrive. Public copies and HTTP CAS use `verifyPublicArtifact` for anonymous HTTP, immutable caching and byte integrity; publication additionally supplies each permitted browser origin for CORS verification.

## Roles and retention

`roles: [serve]` is the default. A public reader needs only readable committed publication control objects and public bodies. It does not initialize worlds, generators, SQLite, a publisher lock or writable directories. Enable source/content management explicitly when required. `publish` requires a reliable target and conditional publication store; temporary caches never substitute for either.

Online cache settings and removal of ineffective source-cache knobs are documented in [server configuration](server-configuration.md). Standalone source readers retain explicit cache options. One positive `resources.work.maxTasks` setting bounds distinct resource tasks; requests for the same task coalesce.

The memory, local and shared derived caches permit zero bytes. Missing local cache, SQLite and workspace configuration means no probing or creation. Selected drivers fail explicitly. Work and handoff budgets are separate positive bounds: reserve before preparing input; admission failures reject before generation. A zero-retention resolve pins its results only until transfer/cancellation or the advertised handoff deadline. Oversized optional cache entries do not evict a hot working set. Optional cache write admission has no unbounded waiting queue.

Local caches have one exclusive writer. Shared cache readers do not create locks, upload or evict remote files; only the publisher fills and prunes that cache. A crashed owner requires an explicitly quiesced recovery, never an expiring lease takeover. Never share a SQLite cache between independent writers.

Local atomic and conditional writes flush file contents before making them visible. POSIX also flushes the containing directory after publication. Node does not support directory flushing on Windows, so Windows retains atomic visibility and file-content flushing but does not provide the same directory-entry durability guarantee after power loss.

World identity, content metadata, retained media originals, publication manifests, index pages, prepared records and backup pins are authoritative data. Cache resize/GC never deletes original media. Public GC marks complete current, retained, prepared and pinned closures; old publications remain at least 7 days and orphans at least 24 hours. Browser publication sessions are at most 24 hours. Public URLs are not a revocation mechanism.

## Sources and formats

`snapshot` declares a controlled/frozen source. Stop external world synchronization and edits while preparing/publishing; the in-process snapshot gate excludes controlled source/content commits. Separate instances must not write the same source during publication. `bounded` explicitly supports external mutable sources: active sources are checked at intervals of at most 5 seconds, using content digests when no fixed revision exists. Observing a change invalidates source metadata and the render root. It is not a cross-file frozen snapshot and cannot publish. Status separates source observation and publication lag.

Chunks use deterministic `chunk-msgpack-v1`: coordinates, terrain NBT and optional entity NBT, with terrain/entity/content digests in the reference metadata. `terrainDigest` and optional `entityDigest` hash decoded NBT independently. `contentDigest` hashes their canonical dependency tuple, including explicit entity absence. The source reader computes this identity once and generation reuses it. `sourceRevision` is an opaque source validator, independent from these digests. The transport artifact digest hashes the encoded MessagePack bytes. File validators and source paths are not encoded into output bytes. Overrides take precedence over MCA through the same source reader used by baking.

Publications using the previous chunk hash field names must be prepared and published again with the matching writer. Readers reject that metadata rather than interpreting legacy field names. The new mesh cache schema also prevents reuse of keys from the previous serializer.

Zero-byte terrain and entity MCA files are read as empty region placeholders without rewriting the archive. Nonempty files shorter than the complete 8 KiB header and invalid declared chunk records remain integrity errors. A declared region becoming empty while its header or chunk body is being read remains a source-change error; it is not silently omitted from an in-progress read.

Mesh render keys use the same strict `canonicalJson` contract as resource keys, with a new mesh cache schema. Browser textures and overlay images share one abortable image loader; rasterization and GPU disposal remain specific to each consumer.

Offline meshes and browser workers share `blockStateKey` and `blockTint`. Block-state keys escape property delimiters; mesh baking passes the actual biome and block state to tinting. The colors4 top-map generator identity and mesh cache schema invalidate outputs from the previous tint policy; rebake old top maps with the matching CLI.

Atlas output is an immutable PNG plus `atlas-manifest-v1`; the manifest contains the PNG ArtifactRef and UV/animation/color metadata, without a URL. The retained explicit atlas POST uses the same generator and repository. Missing optional textures are explicit missing results; malformed PNG/JSON, I/O and integrity errors are errors.

Top-map payloads remain v6. New manifests carry a complete environment dependency digest and per-region action/output references. Terrain (including overrides), pack models/textures/animation metadata/colormaps, biome and block data, lighting and sampling parameters participate. Old MCA SHA-1 records do not prove validity. Use the matching 0.4 CLI to rebake; the server reports `TOPMAP_REBAKE_REQUIRED` for absent/stale dependency records. Bake with the same selected packs, block data, biome data and Minecraft data version as the server.

## Protocol and operations

- `GET /api/resources/views/current?world=...`: ETag/no-cache head.
- `POST /api/resources/resolve`: `{viewId, selectors}`, at most 128 typed selectors, with `validUntil`.
- `GET/HEAD /api/resources/:viewId/:kind/:digest`: server-mode body membership, authorization, Range and validators. It is absent in public mode.
- The viewer calls `resolveChunks` once and retains each reference with its view and `validUntil`. `readChunks` reads those exact references without another resolve; expired references must be explicitly resolved again. Changed views reject stale bytes.
- World inventory, capabilities, coverage and top-map manifests share resource projections in both modes. The old world chunk/chunks/chunk-hashes and top-map tile body routes are removed; use resource selectors and resolved URLs. These reads retain no route or hash-field aliases.
- Overlay manifests require `dimension` and `viewId`; each media entry is `{version, resource}`. One handler supplies validation, ETag/no-cache and conditional 304 responses in both delivery modes. Retained authenticated library reads and current-binding media reads remain business APIs.
- `GET /api/admin/resources/status` and explicit publisher prepare/publish/verify/GC operations require the configured management role. A publication requires an expected parent head.

```sh
violet-map resources prepare --via local --server-config publisher.yaml --writers-quiesced --output prepared.json
violet-map resources status --via local --server-config publisher.yaml
violet-map resources publish --via local --server-config publisher.yaml --expected-head none --writers-quiesced --prepared prepared.json
violet-map resources verify --via local --server-config publisher.yaml
violet-map resources reindex --via local --server-config content-reader.yaml --writers-quiesced
violet-map resources gc --via local --server-config publisher.yaml --writers-quiesced
# Only after stopping every other writer:
violet-map resources recover --via local --server-config publisher.yaml --writers-quiesced
```

`prepare` returns the complete current-protocol manifest; `--output` saves that same document for review. `publish --prepared` checks it against the current frozen source before uploading, then checks the final closure again before changing the head. Source drift fails explicitly. Direct publication with an expected parent remains the explicit operation used by an online writer reconciling business revisions. Offline CLI commands do not start the service's background reconciliation timer.

Public verification reserves its own configured work memory even for a source-free reader. Configured publication retention applies to both old-head reads and garbage collection. A public service that enables only content reads initializes the original-media repository, while derived cache, SQLite and workspace implementations remain unloaded until dynamic source capabilities need them.

For an online writer, use the same commands with `--server-url`/the selected CLI profile (the default `--via api`); only the running publisher commits and runs GC. Local changes require every other writer to be stopped and `--writers-quiesced`. Local `reindex` rebuilds only the explicitly selected disposable SQLite index, verifies retained originals and indexes the authoritative publication.

Use the actual current SHA-256 for subsequent `--expected-head`. Stable publications short-circuit before any authoritative PUT, including writer/prepared records. Failed closure verification leaves the old head visible. A prepared record includes its full recovery closure; head visibility is a conditional operation. A failure to delete prepared metadata after head commit is a cleanup failure, not a failed business commit.

Content commits keep their own revision. Co-located publishers mark publication pending and debounce changes with a maximum delay. Publication failure does not undo a successful content commit. A separate publisher explicitly prepares/publishes from committed source/content. Never infer that a business revision is already public.

## Backends and public HTTP

See [role examples](../examples/resources). Object targets use the same local/S3 adapter regardless of AWS, MinIO or R2. Configure a public base URL explicitly; bucket names never imply a domain. Public GET/HEAD must be anonymous, return the exact MIME and bytes, permit the viewer's Origin, and carry `public, max-age=31536000, immutable`. Heads use no-cache/bypass. Do not cache 404 responses for long periods. Configure caching for extensionless MessagePack objects explicitly. After changing a CDN CORS policy, invalidate cached responses as required by that provider.

Local public CAS creates `.violet-http` metadata sidecars before making bodies visible. A static host must apply those sidecars' MIME/cache metadata; merely serving extensionless files as octet-stream fails publication verification. Keep that private metadata directory inaccessible from HTTP. Do not expose the original blobs mount.

An HTTP target is selected with `resources.delivery.httpPublisher: {url, tokenEnv}` instead of `targetMount`. Readers need only `publicBaseUrl`; publishers resolve the named credential environment variable. The explicit CAS protocol is:

- authenticated `POST v1/missing` with at most 256 representation keys, returning `{missing: [...]}`;
- atomic authenticated `PUT v1/objects/:representationKey`, `If-None-Match: *`, MIME, immutable metadata and SHA-256; only 201/204 or a verified 412 is successful;
- anonymous `GET/HEAD objects/:shard/:representationKey` with byte ranges;
- authenticated paged `GET v1/inventory?cursor=...`, at most 1000 `{path,size,modifiedAt}` objects and `nextCursor` (empty at end), and `DELETE v1/objects/:representationKey` for explicit GC.

Representation identity is a canonical hash of content digest, MIME and identity encoding. Public verification checks the actual anonymous HTTP channel before commit. It never uses source credentials or an application-body substitute.

## Backup, recovery and verification

Stop all writers before content snapshots. Back up world identities, business heads and every retained original, including tombstones. Resource caches may be omitted. Back up publication control/objects as a complete closure or hold a named backup pin while copying it. Never recover an original from a public copy. Restore business data without changing IDs, verify originals, rebake if required, prepare/publish/verify, then point readers at the committed head.

Run `test:resources`, `test:resources:browser`, `test:resources:roles` and `bench:resources`, in addition to workspace production/frontend/release checks. The fixed benchmark fixture and 1.10 low-benefit P95/CPU thresholds live in `scripts/bench/resources-fixture.json`; reports distinguish generation, byte hits, capacity and RSS. Real provider runs and skipped tests must be reported separately. No script in this change deploys automatically.

Controlled source synchronization does not trigger an intermediate publication. Source mutations mark `requiresSourceSnapshot`; complete the synchronization, freeze the source, then explicitly prepare/publish. This marker survives publisher restart and prevents an unrelated content debounce from publishing a partially synchronized source. Content revisions remain committed even while their publication is pending.

For a source-free reader, `compose.resources-reader.yaml` demonstrates a read-only root and only a read-only configuration bind. Select a private environment file containing reader credentials; no local cache/workspace/user database is required. The application must have explicit read access to committed control/objects. Do not use writer credentials for this reader.
