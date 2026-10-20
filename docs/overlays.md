# External overlays

Resource delivery uses the coordinated 0.4 protocol. See [Unified resources](resources.md) for role, zero-retention, optional persistence, publication and migration contracts.

External overlays provide storage, configuration, persistence, API/CLI management and viewer rendering for curves, areas, images, SVG and static GLB. Admin has no overlay editor; publish content with CLI/API, then select the registered map in the viewer.

## Object storage

`@violet-map/core/storage` defines `ObjectReader`, `ObjectStorage`, and `AtomicObjectStorage`. The latter adds `replace`, guaranteeing one complete object becomes visible at a time. Local replacement uses a temporary file and same-filesystem rename; S3 replacement uses one completed PUT. This is not cross-object atomicity, conditional update or crash durability/fsync.

`@violet-map/storage/factory` exposes `createObjectStorage` for local and S3 physical stores, with lazy AWS imports. Local/S3 subpaths export `LocalStorage`/`S3Storage`; the root exports `ScopedStorage`, `CachedStorage`, `copyObjects` and content comparison. A scope returns relative paths; caches coalesce metadata requests and invalidate generations after writes. Directory prefix operations operate on descendants: `a` and `a/` select `a/file`, exclude object `a`, and never select `ab/file`. Local deletion preserves a same-name file, matching S3. Empty prefix selects all descendants. Local `.violet-tmp-` filenames are reserved for replacement and hidden from listing. Missing objects return null; backend errors propagate. Ranges require nonnegative safe integers, zero-length ranges still check existence, EOF yields empty bytes, and missing objects yield null.

Remote `ServerWorldStorage` is a distinct supported world protocol, constructed through `/server`. Server library consumers select `services.mounts.worlds` directly. World identity creation/force policy and identity-last publication remain in world sync; general object copying has no world policy. See [storage migration](world-storage.md).

## Backends and mounts

One physical root:

```yaml
deployment: { profile: sync }
auth: { mode: static, staticRole: admin }
features: { contentReads: true, contentWrites: true }
storage:
  backends:
    main: { driver: local, root: /srv/violet }
  mounts:
    worlds: { backend: main, prefix: worlds }
    content: { backend: main, prefix: content }
    blobs: { backend: main, prefix: blobs }
```

A local world root with auxiliary R2/S3:

```yaml
storage:
  backends:
    archives: { driver: local, root: /srv/minecraft/worlds }
    auxiliary2:
      driver: s3
      endpoint: https://ACCOUNT.r2.cloudflarestorage.com
      region: auto
      bucket: violet
      forcePathStyle: true
      accessKeyIdEnv: VIOLET_R2_KEY
      secretAccessKeyEnv: VIOLET_R2_SECRET
  mounts:
    worlds: { backend: archives, prefix: '' }
    content: { backend: auxiliary2, prefix: metadata }
    blobs: { backend: auxiliary2, prefix: blobs }
```

Names match `[a-z][a-z0-9]*`; `legacy`, `auxiliary`, `worldoverride` are reserved normalization names. Named-backend environment fields map exactly: `STORAGE_BACKEND_MAIN_DRIVER`, `_ROOT`, `_ENDPOINT`, `_REGION`, `_BUCKET`, `_FORCE_PATH_STYLE`, `_ACCESS_KEY_ID_ENV`, `_SECRET_ACCESS_KEY_ENV`, `_SESSION_TOKEN_ENV`; mount fields are `STORAGE_MOUNT_WORLDS_BACKEND` and `_PREFIX` (also CONTENT/BLOBS). Credential fields contain an environment variable name, not a key. Unspecified named S3 credentials use the SDK chain. Backend prefixes are forbidden; prefixes belong to mounts.

ENV overrides YAML; same-priority old and new definitions must agree. Legacy `WORLD_STORAGE`, `WORLDS_DIR`, `S3_*` project only onto worlds. An old ENV override clones the worlds configuration instead of changing a shared backend. Relative YAML roots resolve from the YAML directory; relative ENV roots resolve from cwd. Overlap is checked against real local paths and normalized S3 endpoint/bucket/segment prefix, including separate names for one location. Reading absent local auxiliary stores does not create them. Content disabled does not mount/access auxiliary stores. Default auxiliary metadata and blobs use `DATA_DIR/content/{metadata,blobs}`, independent of `WORLDS_DIR`. `ASSETS_DIRS` remains ordered Minecraft resource-pack roots.

Server library consumers use `AppServices.mounts.worlds`; the deprecated `AppServices.storage` projection has been removed. Existing configuration projections `storage.driver`, `worldsDir`, `s3` retain their original meaning for callers; only the normalized mounts drive backend construction.

## Format 1

All documents use `schemaVersion: 1`. `revision` is a positive integer document revision. SHA-256 `versionId` identifies media bytes and is independent of document revision. Unknown fields and format versions are rejected. IDs are 1–128 ASCII letters/digits/underscore/dash, starting with a letter or digit. Names are 1–256 characters. Coordinates, rotations (radians), heights, sizes and scale are finite numbers; scale, dimensions and width are positive. Colors are `#RRGGBB`, opacity is 0–1. Coordinates are target-dimension block coordinates; bindings have no transform or automatic Nether scaling.

Layer example:

```json
{
  "schemaVersion": 1,
  "layerId": "import-fixture",
  "revision": 1,
  "name": "Village routes",
  "features": [
    {
      "featureId": "route",
      "kind": "curve",
      "closed": false,
      "nodes": [
        { "anchor": [0, 64, 0], "in": [0, 0, 0], "out": [10, 2, 0] },
        { "anchor": [20, 64, 20], "in": [-5, 0, 0], "out": [0, 0, 0] }
      ],
      "style": { "color": "#aa44ff", "opacity": 1, "width": 2, "widthUnit": "blocks" }
    },
    {
      "featureId": "village",
      "kind": "area",
      "ring": [
        [0, 0],
        [64, 0],
        [64, 64],
        [0, 64]
      ],
      "minY": -64,
      "maxY": 320,
      "fill": { "color": "#aa44ff", "opacity": 0.3 },
      "wall": { "color": "#aa44ff", "opacity": 0.5, "occlusion": "terrain" }
    }
  ]
}
```

Curves have 2–4096 nodes (closed: at least 3). Handles are relative to anchors. Closure adds the last-to-first segment, never smooths control points, and never repeats the first node at the end. Degenerate open segments are legal. Width units are `blocks` or `pixels`.

Areas have 3–2048 XZ vertices; no repeated endpoint, self-intersection, touching nonadjacent edges, overlapping edges, holes or zero area. Absolute `minY < maxY` defines finite extrusion. Top view means planar projection; wall occlusion is `terrain` or `always`.

A media feature optionally specifies `lighting: label|scene` and has `featureId`, `kind: media`, `assetId`, pinned `versionId`, XYZ `position`, XYZ Euler `rotation` in radians, positive XYZ `scale`, and nonempty `views` drawn from `top`/`player`. A GLB uses `placement: model`. Images use `placement: plane|billboard|upright`, positive `[width,height]` `size` in blocks and normalized `[x,y]` `anchor`. The service checks placement against media type. Feature IDs are unique within a layer. Layer count limit: 10,000 features.

Maps have `mapId`, `name`, `worldKey` (world directory name or null), optional `expectedArchiveId`, revision and `bindings`. A binding has `bindingId`, complete normalized `dimension`, `layerId`, `enabled`, integer `order`. Missing namespace becomes `minecraft`. Bindings sort by order then identity. A world can have multiple map registrations; `/api/worlds` adds `mapIds` when available. Unregistered worlds retain their behavior.

Supported media: decoded static PNG/JPEG/WebP (at most 16,777,216 pixels), SVG with positive pixel dimensions or viewBox and a static shape/path/group/gradient/clip/mask/local-use subset. SVG text must be converted to paths; scripts, event handlers, CSS/style, animation, images, foreignObject, declarations and external references are rejected. Originals are retained. The viewer rasterizes images/SVG locally without publishing derived files. GLB 2.0 uses embedded buffers and PNG/JPEG buffer-view images, static scene geometry, and no extensions (including Draco, Meshopt, KTX2), skinning, morph targets or animation. Khronos validator checks GLB structure/data; scene bounds include node transforms. Unsupported input returns `UNSUPPORTED_FORMAT`.

## Persistence and lifecycle

Metadata paths: `maps/<id>.json`, `layers/<id>/head.json`, `layers/<id>/revisions/<revision>.json`, `assets/<id>/head.json`, `assets/<id>/versions/<sha256>.json`. Blobs use `sha256/<first-two>/<sha256>`. Map documents publish in one replacement. Layer heads point to the last committed revision; media heads contain the public document, retained published-version list and deletion state. Blobs and immutable layer revisions are written before publishing the head. Failed unpublished files may remain orphaned; there is no automatic GC. Deletion publishes a tombstone head retaining the last committed revision/version set. Old revisions remain readable; unpublished orphan revisions/versions cannot be read through the API or act as references. Asset deletion/version removal is rejected while any retained layer revision references it.

One `ContentService` serializes all metadata checks and publication. Run one writer process only; this is not a distributed lock. Multiple independent read-only processes are possible. Railway deployment scripts stop the previous deployment and allow its drain window before starting another writer, with a maintenance window.

Map registration reads existing world identity without writing it. It pins an existing marker by default. No marker produces `unverified`; a pinned missing/different marker produces `mismatch`; absent source produces `missing`; null source produces `unbound`. Missing/mismatched/unbound maps retain external content but return no public overlays. Copies get new map IDs and no inferred sharing. Rebind explicitly to move a source; shared layer changes affect all its bindings. World sync continues to create identity markers, separately from registration.

## API and CLI

`CONTENT_READS_ENABLED` and `CONTENT_WRITES_ENABLED` default false. Writes require reads, admin API and authentication. Read-only public and statically authenticated sync modes never initialize a user DB. Content management requires ci or higher. Diagnostics remains independent of admin API. `DIAGNOSTICS_UPLOAD_TOKEN` optionally allows only diagnostic upload, with no admin privileges. When blob mounts are enabled, diagnostics use `blobs/diagnostics/` and game-data API overrides use `blobs/server-data/`, both durable across container replacements.

| Operation                      | API                                                           |
| ------------------------------ | ------------------------------------------------------------- |
| List/create registrations      | GET/POST `/api/admin/maps`                                    |
| Read/replace/delete map        | GET/PUT/DELETE `/api/admin/maps/:id`                          |
| List bindings                  | GET `/api/admin/maps/:id/bindings`                            |
| Set/remove binding             | PUT/DELETE `/api/admin/maps/:id/bindings/:bindingId`          |
| List/import layers             | GET/POST `/api/admin/overlays/layers`                         |
| Read/replace/delete layer      | GET/PUT/DELETE `/api/admin/overlays/layers/:id`               |
| Retained revision/export       | GET layer with `?revision=N`; GET `/:id/revisions`            |
| Copy layer                     | POST `/api/admin/overlays/layers/:id/copy` with optional name |
| List/import assets             | GET/POST `/api/admin/media`                                   |
| Read/delete asset              | GET/DELETE `/api/admin/media/:id`                             |
| List/add versions              | GET/POST `/api/admin/media/:id/versions`                      |
| Read/remove version            | GET/DELETE `/api/admin/media/:id/versions/:versionId`         |
| Read source bytes (management) | GET version endpoint plus `/file`                             |
| Public manifest                | GET `/api/maps/:id/overlays?dimension=minecraft:overworld`    |
| Public bound source bytes      | Manifest resource URL; requires map/dimension binding         |

Creation generates a new identity. Layer import/export uses complete documents; replace requires the same ID and next revision. Map replacement uses complete documents. Binding mutations use the parent map revision. Mutations/deletes use `If-Match: "N"`; GET document ETag is the quoted revision. Missing conditions return 428 `PRECONDITION_REQUIRED`; stale conditions return 412 `REVISION_CONFLICT`. Clients never retry conflicts with a new revision. Reference conflicts return 409 `REFERENCE_CONFLICT`, malformed content 400 `INVALID_CONTENT`, unsupported schema/media 415 `UNSUPPORTED_FORMAT`, missing content 404 `CONTENT_NOT_FOUND`, source resource mismatch 409 `SOURCE_MISMATCH`, backend errors 503 `CONTENT_BACKEND_UNAVAILABLE`. Corrupt stored documents fail explicitly. Metadata mutations reserve bounded capacity before buffering JSON. Media uploads use a separate bounded import capacity before buffering/decoding; excess requests return 503 `CONTENT_BUSY` with `Retry-After: 1` (see server configuration). Media upload is raw bytes with MIME Content-Type and `?name=...`, never a server file path. Public resources are only reachable through currently enabled bound layers; full library reads require authentication.

Capabilities protocol 1 is extended additively. New clients normalize absent content flags to false. CORS includes If-Match and existing conditional/Range headers. Resource URLs use `/api/` references compatible with `resolveApiResourceUrl` and independent API prefixes. Existing raw admin storage endpoints remain exclusively worlds.

## Public resource delivery

Overlay manifest 2 contains `{version, resource}` with one integrity-checked URL. Configure `resources.delivery` together with map resources; the original blobs mount remains private. Public errors stay errors. Retained library and current-binding media endpoints keep their business authorization and Range semantics. See [Unified resources](resources.md).
