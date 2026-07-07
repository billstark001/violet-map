# Violet Map

Violet Map is a pnpm workspace for inspecting Minecraft Java worlds in a browser:

| Package | Purpose |
| --- | --- |
| `@violet-map/core` | Pure data and rendering algorithms: NBT parsing, region extraction, model baking, meshing, lighting, colors, and LOD meshes. |
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

## Development

```bash
pnpm dev
```

Default services:

| Service | URL |
| --- | --- |
| API server | <http://localhost:8787> |
| Viewer | <http://localhost:5173> |
| Admin | <http://localhost:5174> |

The viewer URL supports camera parameters such as `?x=&y=&z=&yaw=&pitch=`.

## Environment

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | API server port. |
| `WORLDS_DIR` | `data/worlds` | Directory containing Minecraft world folders. |
| `ASSETS_DIRS` | `data/assets` | Comma-separated asset directories; later entries override earlier entries. |
| `DATA_DIR` | `data` | Runtime data directory for editable defaults. |
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

When running from the repository root with the bundled sample layout, use absolute paths or paths relative to the server package working directory. For example:

```bash
WORLDS_DIR=$PWD/packages/server/data/worlds \
ASSETS_DIRS=$PWD/packages/server/data/assets \
DATA_DIR=$PWD/packages/server/data \
pnpm --filter @violet-map/server dev
```

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
| `bake-lod <world>` | Bake region-scoped LOD mesh tiles and update `.violet-map/top-map/manifest.json`. |
| `bake-heightmap <world>` | Bake top-view height/color tiles and update `.violet-map/top-map/manifest.json`. |

## Runtime APIs

- Chunk payloads are served as MessagePack. The single-chunk endpoint is available at `/api/worlds/:world/:dim/chunk/:cx/:cz`, and the viewer uses `/api/worlds/:world/:dim/chunk-hashes` before incrementally requesting changed or evicted chunks from `/api/worlds/:world/:dim/chunks`.
- Chunk responses include the source file hash (`hash`/`fileHash`), source type (`region` or `chunk`), and chunk NBT hash (`nbtHash`). For chunks inside `.mca` files, the source hash is the whole region file hash.
- Top-map capabilities are exposed at `/api/worlds/:world/capabilities` with `hasTopMap`, `hasLod8`, and `hasHeightMap` flags. Offline tiles are served from `/api/worlds/:world/:dim/top-map/:kind/:rx/:rz`.
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
- If stored light is missing, fallback lighting is baked per column and may have subtle chunk-boundary seams.
- Fluid rendering approximates vanilla levels and neighbor seams but does not simulate animated flow textures.
