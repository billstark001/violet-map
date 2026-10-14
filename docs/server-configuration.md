# Server configuration

[Back to README](../README.md)

CLI profiles and state are described in [CLI configuration and credentials](cli-configuration.md). Server deployment settings remain independent. Non-sensitive values can be set as environment variables or in `violet-map.yaml` / `violet-map.yml`; use `VIOLET_MAP_CONFIG` to select another file. The file supports standard nested YAML maps and lists. A malformed file stops startup with its path in the error; environment variables take precedence. Relative paths in YAML resolve from the YAML file's directory; paths in environment variables resolve from the process working directory.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3300` | API port. |
| `WORLDS_DIR` | `data/worlds` | Local world directory. |
| `DATA_DIR` | `data` | Runtime data directory, including default PGlite data. |
| `DATABASE_URL` | unset | PostgreSQL connection string; enables PostgreSQL instead of PGlite. |
| `DATABASE_DIR` | `DATA_DIR/users.pglite` | PGlite data directory override. |
| `ROOT_USERNAME`, `ROOT_PASSWORD` | unset | Define the optional virtual root account; both are required. |
| `WORLD_STORAGE` | `local` | `local` or `s3`. |
| `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_PREFIX` | — | World-storage S3 configuration. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_SESSION_TOKEN` | — | S3 credential pair and optional temporary session token; otherwise use the SDK provider chain. |
| `S3_FORCE_PATH_STYLE` | `true` | Set false for virtual-hosted-style S3. |
| `ASSETS_DIRS` | bundled defaults, `data/assets` | Comma-separated resource pack directories; later directories override earlier ones. |
| `MC_VERSION` | `1.21.4` | Default version for generated data/minimal `level.dat`. |
| `MC_DATA_VERSION` | `MC_VERSION` | `minecraft-data` version override. |
| `REGION_CACHE_BYTES` | `268435456` | Full region cache cap. |
| `CHUNK_NBT_CACHE_BYTES` | `134217728` | NBT cache cap. |

Example:

```yaml
server:
  port: 3300
worldsDir: /srv/violet-map/worlds
dataDir: /srv/violet-map/data
worldStorage: s3
s3:
  endpoint: https://s3.example.com
  region: auto
  bucket: violet-worlds
  prefix: production
  forcePathStyle: true
```

Secrets (`DATABASE_URL`, root password, S3 secrets, credentials) must remain in environment variables or your deployment secret manager.
