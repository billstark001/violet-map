# External overlays

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

## Public media delivery

The proxy remains available in every configuration. To advertise an additional anonymous object URL, set `MEDIA_PUBLIC_BASE_URL=https://media.example.com/blobs/` or YAML `content.mediaPublicBaseUrl`. This absolute HTTP(S) URL identifies the **blobs mount root as exposed by your CDN**, including its mount prefix. It must have no credentials, query or fragment. A blob `sha256/ab/abcdef...` then resolves below that root; object-key segments are URL-encoded by the shared `createPublicObjectUrl` storage utility. No URLs are signed and no remote bucket settings are changed by this option.

Requests to `/api/maps/:id/overlays?dimension=overworld&delivery=public` add optional `media[].publicUrl` while retaining each API-relative `url`. Omit `delivery`, or use `delivery=proxy`, to retain the original manifest shape for existing strict clients. The viewer requests public delivery by default, falls back to `url` on CORS/network/HTTP/size/digest failures, and always checks the pinned byte count and SHA-256. Both requests share one 30-second download deadline and omit credentials; redirects are rejected. Set viewer `runtime-config.json` to `{ "apiBaseUrl": "https://api.example.com/", "mediaDelivery": "proxy" }` to force proxy delivery. Old servers ignore the new query and continue providing proxy-only manifests.

Expose **only** the `sha256/` media subtree at the public origin. The same blobs mount also contains `diagnostics/` and `server-data/`; metadata, diagnostics and worlds must remain private. Enabling public access on a shared R2 bucket exposes its objects regardless of application mount prefixes, so use a path-restricted public gateway/CDN or a separate media-only public replica. Merely setting a base URL neither copies objects nor creates that isolation. Public immutable object URLs can remain usable after unbinding or API deletion; use proxy delivery when access must follow current map bindings. Direct delivery currently covers overlay media only; world regions, textures and top-map tiles retain their existing API paths.

For R2 production traffic use a [custom domain](https://developers.cloudflare.com/r2/buckets/public-buckets/) and configure [CORS](https://developers.cloudflare.com/r2/buckets/cors/) for the viewer origin with GET/HEAD. `r2.dev` is intended for development. The public origin must return the original bytes and matching MIME type. Purge previously cached responses after changing CORS. Browser acceptance covers a separate static, API and public-media origin, successful direct reads, actual CORS failure, corrupted CDN bytes, proxy fallback and cookie isolation.

CLI uses the existing profile/token references and API prefix. Examples (`violet-map` means the installed binary or `pnpm violet-map`):

```sh
violet-map map register --world wupa_village --name wupa_village
violet-map map list
violet-map map show MAP_ID
violet-map map rebind MAP_ID --world moved --if-match 1
violet-map media import marker.svg --name marker
violet-map media import marker-v2.svg --asset ASSET_ID --if-match 1
violet-map media list
violet-map media show ASSET_ID
violet-map media versions ASSET_ID
violet-map overlay layer validate layer.json
violet-map overlay layer import layer.json
violet-map overlay bind --map MAP_ID --binding main --layer LAYER_ID --dimension overworld --if-match 1
violet-map overlay manifest --map MAP_ID --dimension overworld
violet-map overlay layer export LAYER_ID --output exported.json
violet-map overlay layer replace LAYER_ID exported.json --if-match 1
violet-map overlay layer copy LAYER_ID --name independent
violet-map overlay unbind --map MAP_ID --binding main --if-match 2
violet-map overlay layer delete LAYER_ID --if-match 2
violet-map media delete ASSET_ID --if-match 2
```

`overlay manifest` reads the public endpoint anonymously: it only requires `contentReads`, works with public deployments where `adminApi` is disabled, and does not load or send a saved/injected credential. Library listings, exports and mutations continue to require the management API and its normal credentials.

Local layer validation only imports core. API management does not require server/storage/render installed; artifact tests check this. Asset extraction and world sync remain available.

## Acceptance and rollback

Fixtures in core/storage/server tests cover legal/illegal/boundary geometry, relative handles, rings, transparent images, SVG, GLB, source identities, same-prefix siblings, cache generations, request conflicts, head failure and restart. CLI integration covers the complete create/import/bind/read/replace/export/unbind lifecycle through an API subpath. The deployment script also runs real R2 missing/Range/scope/prefix/atomic visibility checks in an isolated disposable prefix.

Before upgrading, back up all three mounts, including retained revisions and versions, plus user DB if using users mode. To roll back an overlay, export a retained revision and replace with the current explicit revision; this creates a new revision. To roll back the service, stop the current writer, deploy the prior commit and keep content reads/writes disabled if that version lacks format support. World data layout and identity format do not migrate. Never remove content/blobs as part of world deletion. Do not GC from only current bindings.

## Viewer display and lifecycle

Only worlds with `mapIds` and servers advertising `contentReads` enable overlays. The settings panel selects a registered map when several exist, toggles display and reports loading, source problems, feature errors and display budgets. `overlayMapId` and `overlaysEnabled` URL settings override saved preferences. Missing capabilities default to disabled; unregistered worlds and disabled overlays make no content requests and load no media or GLB loader. The viewer still initializes its existing terrain pipeline. Empty registered maps require only their manifest.

Manifests refresh every 30 seconds while the page is visible, use ETags and retry failures after 12 seconds. Each manifest request, including its response body, has a 30-second timeout so stalled connections can recover. Context changes abort pending work and reject stale responses, including delayed JSON/decode completion. Invalid/missing resources report binding/layer/feature identity without stopping other features or the terrain. Existing same-context content survives transient manifest failures. Images have a 30-second download timeout. Binding order, binding ID and feature ID determine stable feature selection, area-mask order and depth-disabled annotation order. Depth-tested translucent objects composite by geometric depth through OIT. Layer updates retain unchanged instances; publishing an asset version does not upgrade pinned instances. Change a feature's `versionId` explicitly to upgrade it.

Curves use adaptive de Casteljau subdivision and conservative control-hull bounds. Handles remain relative; no automatic smoothing occurs. The projected control hull is within 0.5 CSS pixels of each chord when the budget is not exhausted. Near the eye plane subdivision can hit the safety cap; behind-camera portions are clipped. Limits are 65,536 points per curve, 200,000 points across active curves and depth 18. Capped segments become coarser chords and the display-budget status is shown; insufficient remaining points suppress the affected curve with a feature error. Pixel widths stay constant in CSS units, independent of device pixel ratio; block widths change with perspective distance. Curves with opacity 0 allocate no visible geometry. Curves obey terrain depth and are not automatically draped onto terrain.

Areas are triangulated from their original single-ring contour. Top views composite a world-XZ RGBA mask into the actual visible terrain fragments, after terrain lighting and before fog. Full chunks, greedy/tiled chunks, LOD and offline top-map sample the same field; changing height or projection cannot shift the boundary like a floating polygon would. Coordinates are rebased before conversion to shader floats. The atlas targets half a screen pixel per texel, with a maximum of 4096 per side (or the GPU limit), at most 64 MiB RGBA. Large spans degrade resolution, use linear filtering and report a mask budget indicator. Area `minY`/`maxY` do not clip the top-view planar projection. Player views instead show finite double-sided walls between those exact heights. `terrain` walls depth-test against solid geometry; `always` walls can show through it. Opacity 0 skips display; opacity 1 fully occludes surfaces behind the wall; intermediate walls blend through the shared transparency pipeline.

Top masks blend premultiplied colors in deterministic order, including opacity 0/0.5/1 and overlapping areas. Depth-tested player walls, curves, images, alpha-blended GLB and translucent water share the sixteen-bin [order-independent transparency pipeline](transparency.md). Object and triangle submission order no longer determine their overlap, although nearby surfaces within the finite bins can still mix colors. An `always` wall intentionally overpaints intervening surfaces. The browser fixture records the water/wall/overlapping-region reference image. Do not assume arbitrary translucent intersections are physically exact.

Images use their declared `[width,height]` in blocks; their aspect ratio is explicit (use the source width/height ratio to avoid stretching). `anchor: [0,0]` is bottom-left, `[0.5,0.5]` is center. In local upright coordinates +X is right and +Y is up; image rows retain the original top-to-bottom orientation. `plane` rotates that local plane -π/2 around X, so image top points toward -Z; `upright` keeps local XY; `billboard` follows the active camera, then applies the feature rotation. All instances apply local positive XYZ scale, XYZ Euler rotation in radians, then world translation. GLB uses one glTF unit per block and preserves its root/node transforms and origin. Model geometry/materials/textures are shared by asset/version; cloned instances have independent transforms.

Image textures are sRGB with straight alpha and double-sided planes. PNG/WebP/SVG keep transparent edges; JPEG has its original opaque pixels. Bitmap texture size is capped at 4096 per side or the GPU maximum without enlarging native images. SVG rasterization targets at least 1024 pixels on its longest side, up to 4096; the original viewBox and declared world size remain unchanged. Images default to unlit `label` mode; static GLB defaults to `scene` mode preserving standard materials. Either can explicitly choose the other mode. GLB label mode uses unlit base color/map/alpha and ignores metallic, roughness, normal and emissive lighting effects. Scene mode receives hemisphere and directional light synchronized with the viewer's day factor; Nether/End receive tinted minimum illumination. This supplies conventional model lighting alongside the terrain's separate custom shader, without dynamic shadows.

The GLB loader is a separate lazy bundle loaded only for visible models. No Draco, Meshopt, KTX2 or remote decoder configuration exists. The viewer rechecks the supported static embedded-only GLB subset before loading, verifies every media download against its pinned SHA-256 and size, and reports unsupported dependencies/extensions. One failed model or bitmap does not stop other layers. Last-owner release destroys shared geometries, materials, textures and ImageBitmaps, including late canceled decodes and unused GLB image sources. Offscreen resources are released immediately; there is no warm media cache. Concurrent downloads are limited to 4, distinct owned versions to 32, individual source downloads to 64 MiB and estimated resident media geometry/texture bytes to 128 MiB. Instance/object overhead, shader programs, decoder temporary memory, driver allocations and render-target memory are separate from that estimate. Mask memory is reported separately. At most 512 visible features are active in binding order; additional features are suppressed and reported. Source documents remain intact.

Diagnostics include active/suppressed feature counts, loading/source status, pending media, versions, estimated media bytes, mask bytes, sampling/resolution caps and up to 20 feature errors. Turning off overlays, changing map/dimension or disposing a viewer releases its objects and shared leases. Browser tests repeat load/unload cycles and check both diagnostics and renderer geometry/texture counters.

## Rendering validation

Run `pnpm build` before `pnpm test:overlays`; the latter uses the built CLI against an actual temporary local server and real Chrome WebGL, with the API under `/violet/`. It imports PNG/JPEG/WebP, viewBox SVG and a GLB through the CLI, then renders fixed 800×600 CSS-pixel scenes. It checks orthographic/perspective top masks across terrain heights 0/12/24 and all three terrain resolutions, wall sides/heights/occlusion and transparency references, actual pixel/block curve widths, image orientation/anchors/alpha, GLB illumination in all dimensions/day factors, shared-version instance removal, explicit version upgrades, context cleanup and the real viewer toggle. An older capability document is also exercised with no overlay API/media/GLB requests. `pnpm test:frontend` checks the built viewer/admin applications and existing diagnostics/token isolation. Pure geometry, manifest and lifecycle tests run with `pnpm test`.

Screenshots and machine-readable CPU/frame/network/resource measurements are written to ignored `LOCAL_railway_deploy/overlay-acceptance/`. See [the rendering validation guide](overlay-rendering-validation.md). Use these fixtures to compare rendering correctness and resource lifetimes; they do not establish general frame-rate guarantees. Release checks and recovery procedures are in [release acceptance](overlay-release-acceptance.md). No annotations are written into world chunks or offline top-map files.

The shared viewer budgets are defined in `packages/web/src/render/overlayLimits.ts` and enforced in pressure acceptance. Backup/restore uses `scripts/operations/content-snapshot.mjs` with quiesced writers and an empty restore destination. Follow [release and recovery](overlay-release-acceptance.md) before replacing binaries or storage locations.
