# Violet Map

Violet Map is a browser-first toolkit for exploring Minecraft Java worlds without opening the game client. It combines offline preprocessing with interactive Three.js rendering, so large worlds can be scanned quickly while nearby chunks still render with model-aware full meshes.

The project is split into a lightweight viewer mode and a full server-backed mode. That makes it useful both as a local visualization/debugging tool and as a small web service for browsing uploaded worlds, editing supporting data, and serving baked top-map tiles.

Its rendering path is intentionally data-oriented: parsing, light baking, LOD generation, and top-map generation live in the core package, while the web app focuses on scheduling, caching, and presenting those meshes smoothly in the browser.

Violet Map is a pnpm workspace with these packages:

| Package | Purpose |
| --- | --- |
| `@violet-map/core` | Pure data and rendering algorithms: NBT parsing, region extraction, model baking, lighting, colors, and the `mesher` module (`full`, `lod`, `topMap`). |
| `@violet-map/assets` | CLI utilities for downloading/extracting Mojang client assets and generating data files. |
| `@violet-map/server` | Hono API server for worlds, chunks, assets, generated atlases, uploads, and editable data. |
| `@violet-map/web` | Three.js viewer with worker-side chunk parsing, meshing, LOD rendering, and fly controls. |
| `@violet-map/admin` | React admin UI for world inspection, region/chunk upload, and biome data editing. |

## Setup

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Prepare vanilla assets. Choose one of the following options.

   Recommended: extract assets with the CLI:

   ```bash
   pnpm --filter @violet-map/assets dev assets list
   pnpm --filter @violet-map/assets dev assets extract --version 1.21.4 --output packages/server/data/assets
   ```

   Manual alternative: extract assets from a local client jar. Minecraft assets are copyrighted and should only be used locally.

   ```bash
   mkdir -p packages/server/data/assets
   cd packages/server/data/assets
   unzip <.minecraft>/versions/1.20.4/1.20.4.jar 'assets/*'
   mv assets/* . && rmdir assets
   ```

   The final layout should be:

   ```text
   packages/server/data/assets/minecraft/{blockstates,models,textures}
   ```

   Additional resource packs can be appended with `ASSETS_DIRS=dirA,dirB`; later directories override earlier ones.

3. Add worlds under:

   ```text
   packages/server/data/worlds/<world-name>/
   ```

   Standard Java world layouts such as `region/`, `DIM-1/`, and `DIM1/` are supported. You can also upload `.mca` region files or individual chunk NBT files from the admin UI.

## Runtime Modes

Violet Map supports two modes:

| Mode | Services | Use |
| --- | --- | --- |
| `light` | Viewer only, no backend | Frontend/static UI work or a viewer shell without world/chunk APIs. |
| `full` | API server, viewer, admin | Normal world browsing, uploads, assets, top-map tiles, and admin workflows. |

Default ports:

| Service | URL |
| --- | --- |
| API server | <http://localhost:3300> |
| Viewer | <http://localhost:3305> |
| Admin | <http://localhost:3310> |

## Development Without Docker

Using pnpm:

```bash
pnpm install
pnpm dev:light
```

For the full stack:

```bash
pnpm dev:full
```

Using npm workspaces:

```bash
npm install
npm --workspace @violet-map/web run dev
```

For the full stack with npm, start these in separate terminals:

```bash
npm --workspace @violet-map/server run dev
npm --workspace @violet-map/web run dev
npm --workspace @violet-map/admin run dev
```

The viewer URL supports camera parameters such as `?x=&y=&z=&yaw=&pitch=`.

## Development With Docker

Light mode:

```bash
docker compose --profile light up web
```

Full mode:

```bash
docker compose --profile full up
```

The compose file mounts the repository into Node containers and runs the same workspace scripts as local development.

## Environment

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3300` | API server port. |
| `WORLDS_DIR` | `data/worlds` | Directory containing Minecraft world folders. |
| `ASSETS_DIRS` | `data/assets` | Comma-separated asset directories; later entries override earlier entries. |
| `DATA_DIR` | `data` | Runtime data directory for editable defaults. |
| `VIOLET_MAP_CONFIG` / `CONFIG_YAML` | | Optional YAML file for non-sensitive server settings. If unset, `violet-map.yaml` or `violet-map.yml` in the working directory is loaded when present. |
| `MC_VERSION` | `1.21.4` | Preferred Minecraft version for generated data and generated `level.dat`. |
| `MC_DATA_VERSION` | `MC_VERSION` | Optional `minecraft-data` version override. |
| `WORLD_STORAGE` | `osfs` | World storage driver. Use `osfs`, `s3`, or `s3-compatible`. |
| `S3_BUCKET` | | Bucket for S3-compatible world storage. |
| `S3_ENDPOINT` | | Optional S3-compatible endpoint. |
| `S3_REGION` | `auto` | S3 region. |
| `S3_PREFIX` | | Optional object key prefix for worlds. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | | S3 credentials when not supplied by the environment. |
| `S3_FORCE_PATH_STYLE` | `true` | Set to `false` for virtual-hosted-style buckets. |
| `ADMIN_TOKENS` | `dev-admin-token:admin,dev-ci-token:ci` | Comma-separated hardcoded tokens and roles. Roles are `admin`, `ci`, and `viewer`; `admin` includes `ci`. |
| `REGION_CACHE_BYTES` | `268435456` | Byte cap for full `.mca` region cache. |
| `CHUNK_NBT_CACHE_BYTES` | `134217728` | Byte cap for decompressed chunk NBT cache. |

Non-sensitive server settings can also be supplied by YAML:

```yaml
server:
  port: 3300
worldsDir: packages/server/data/worlds
assetsDirs:
  - packages/server/data/assets
dataDir: packages/server/data
worldStorage: osfs
s3:
  endpoint: http://localhost:9000
  region: auto
  bucket: violet-map
  prefix: worlds
  forcePathStyle: true
```

Sensitive values stay in environment variables only: `ADMIN_TOKENS`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY`.

## Asset CLI

```bash
pnpm --filter @violet-map/assets dev --help
```

| Command | Description |
| --- | --- |
| `assets list` | List available Minecraft release versions. |
| `assets extract --version <id> --output <dir>` | Download a Mojang client jar and extract blockstates, models, and textures. |
| `assets extract-all --min-version <id>` | Extract assets for every release at or above a version. |
| `assets generate-biomes --version <id>` | Generate `biomes.json` with sky, fog, water, grass, and foliage color data. |
| `assets generate-dimensions --version <id>` | Generate `dimensions.json` for the standard dimensions. |
| `profile-mca <file.mca>` | Profile parse, height, full mesh, and LOD mesh work for one region file. |
| `bake-topmap <world>` | Bake top-map height/color tiles plus sky/block light cache and update `.violet-map/top-map/manifest.json`. |

`bake-topmap` supports `--approach top|bottom` for top-down worlds or underside/floating-island worlds, and `--light-mode stored-first|rebake`. `stored-first` uses saved light data when present and fills missing light per column; `rebake` ignores saved light and recomputes sky/block light for the tile cache. Transparent overlays such as water, glass, and ice tint the baked top-map color while the output tile remains a single opaque color sample.

## Runtime APIs

- Chunk payloads are served as MessagePack. The single-chunk endpoint is available at `/api/worlds/:world/:dim/chunk/:cx/:cz`, and the viewer uses `/api/worlds/:world/:dim/chunk-hashes` before incrementally requesting changed or evicted chunks from `/api/worlds/:world/:dim/chunks`.
- Chunk responses include the source file hash (`hash`/`fileHash`), source type (`region` or `chunk`), and chunk NBT hash (`nbtHash`). For chunks inside `.mca` files, the source hash is the whole region file hash.
- Top-map capabilities are exposed at `/api/worlds/:world/capabilities` with per-dimension `hasTopMap`. Offline tiles are served from `/api/worlds/:world/:dim/top-map/tile/:rx/:rz`.
- Texture loading supports both individual PNG requests and a generated atlas mode. The viewer first requests `/api/assets/atlas` and falls back to individual textures if atlas generation fails.
- The worker receives transferable binary chunk buffers and builds typed-array mesh buffers for return to the main thread.

## Admin and CI APIs

Write APIs require `Authorization: Bearer <token>` or `x-violet-admin-token`. The default development token is `dev-admin-token`.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/admin/worlds` | Create an empty world and generate a minimal modern `level.dat`. |
| `GET /api/admin/worlds/:world/manifest` | Return all files in a world with size, mtime/etag, and sha256 hash. |
| `POST /api/admin/worlds/:world/diff` | Compare a client manifest and return `upload`, `same`, and `remoteExtra` paths for incremental sync. |
| `PUT /api/admin/worlds/:world/files/*` | Upload or replace one world file by relative path. |
| `POST /api/admin/worlds/:world/files` | Multipart file upload with `file` and `path` fields. |
| `POST /api/admin/upload` | Compatibility upload for `.mca` region files or single chunk NBT. |
| `DELETE /api/admin/worlds/:world/:dim/chunks` | Delete chunk overrides and clear chunk entries from region headers. |
| `DELETE /api/admin/worlds/:world/:dim/regions/:rx/:rz` | Delete a region file. |
| `DELETE /api/admin/worlds/:world` | Delete a whole world. |

Uploaded worlds do not need to include `level.dat`; the server generates a minimal Java 1.21-style file when the world is first created or written.

## Current Limits

- Only 1.18+ chunk sections using `sections` and `block_states` palettes are supported.
- Entities and block entities are not rendered.
- Biome tinting is sampled per block; radius blending is not implemented yet.
- If stored light is missing, fallback lighting is baked per column and may have subtle chunk-boundary seams. `bake-topmap --light-mode rebake` can build a fresh top-map sky/block light cache without trusting saved light data.
- Fluid rendering approximates vanilla levels and neighbor seams but does not simulate animated flow textures.
