# World storage and safe synchronization

Resource delivery uses the coordinated 0.4 protocol. See [Unified resources](resources.md) for role, zero-retention, optional persistence, publication and migration contracts.

[Back to README](../README.md)

World names are single portable directory segments, including Unicode, spaces and URL characters such as `#` and `%`. HTTP callers encode the complete name as one URL component. Empty names, path separators, control characters, Windows-invalid filename characters, reserved device names and trailing dots/spaces are rejected; names are at most 255 UTF-16 code units. This is shared by server operations, CLI world synchronization and overlay registrations so a world cannot escape or alias its mount. Creation validates level names and every dimension before any write; malformed JSON/metadata returns HTTP 400 without leaving a partial world.

S3 prefix deletion uses [bulk deletion](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html), which [R2 also supports](https://developers.cloudflare.com/r2/api/s3/api/). Each request contains at most 1000 keys and at most four requests run simultaneously; an HTTP 200 with per-key failures still rejects. Deletion is not transactional: completed keys remain deleted if another key/batch fails. Directory prefixes exclude same-name and sibling objects, including after normalization of `/` or `.` to the root.

`ObjectReader`, `ObjectStorage`, and `AtomicObjectStorage` interfaces live in `@violet-map/core/storage`. Install the CLI optional peer `@violet-map/storage` alongside the CLI to synchronize worlds. The implementations have separate entries:

1. `@violet-map/storage/local` — a filesystem root.
2. `@violet-map/storage/s3` — AWS S3 or S3-compatible object storage.
3. `@violet-map/storage/server` — a remote Violet Map server through authenticated storage APIs.

Use `LocalStorage`, `S3Storage`, `ScopedStorage`, and `CachedStorage` directly, or `createObjectStorage` from `/factory` for a physical local/S3 backend. Construct `ServerWorldStorage` from `/server` for the authenticated world protocol. The deprecated world-named interface/class aliases and `createWorldStorage` have been removed. Server library consumers use `services.mounts.worlds` in place of the former `services.storage` projection.

The server selects `local` or `s3` with `WORLD_STORAGE`. The CLI syncs a **local world archive** to any of the three. It creates `.violet-map/identity.json` in the source archive and checks it against the target before writing. A different or missing marker on a non-empty target emits a warning and aborts unless `--force` is explicitly supplied.

```bash
# Local archive -> another filesystem worlds root
pnpm violet-map world sync \
  --from /backups/my-world --world survival --target local \
  --target-dir /srv/violet-map/worlds --delete

# Local archive -> S3-compatible storage, using an SDK profile or injected credentials
pnpm violet-map world sync \
  --from /backups/my-world --world survival --target s3 \
  --s3-endpoint https://s3.example.com --s3-bucket violet-worlds --s3-prefix production --aws-profile maps

# Local archive -> remote server, sharing the saved production login
pnpm violet-map world sync \
  --from /backups/my-world --world survival --target server \
  --profile production
```

`--dry-run` prints changes without writing. `--delete` mirrors deletions from source to target. `--force` is intentionally separate and should only be used after confirming the target is the same world. Sync hashes same-size files before skipping them, so it works across local filesystems, S3 etags, and server storage consistently.

The server exposes its shared storage adapter under protected `/api/admin/storage/*` endpoints. This is what makes remote CLI sync work, while regular Admin uploads and world edits use the same adapter directly.

Remote storage accepts an API prefix such as `https://api.example.com/violet/` and requires enabled admin/world-write capabilities for synchronization. A sync deployment uses a static Bearer service credential without a user database. The storage root entry exports decorators and synchronization only; local/HTTP operations do not load the AWS SDK.

See [external overlays and named storage mounts](overlays.md) for the object storage, content API, CLI, configuration and persistence contract.
