# World storage and safe synchronization

[Back to README](../README.md)

`WorldReader` and `WorldStorage` interfaces live in `@violet-map/core/storage`. Install the CLI optional peer `@violet-map/storage` alongside the CLI to synchronize worlds. The implementations have separate entries:

1. `@violet-map/storage/local` — a filesystem root.
2. `@violet-map/storage/s3` — AWS S3 or S3-compatible object storage.
3. `@violet-map/storage/server` — a remote Violet Map server through authenticated storage APIs.

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

See [external overlays and named storage mounts](overlays.md) for the phase 1–4 object storage, content API, CLI, configuration and persistence contract.
