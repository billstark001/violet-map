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
   pnpm --filter @violet-map/assets dev list-versions
   pnpm --filter @violet-map/assets dev extract --version 1.21.4 --output packages/server/data/assets
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
| `MC_VERSION` | `1.20.4` | Preferred Minecraft version for generated data. |
| `MC_DATA_VERSION` | `MC_VERSION` | Optional `minecraft-data` version override. |

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
| `list-versions` | List available Minecraft release versions. |
| `extract --version <id> --output <dir>` | Download a Mojang client jar and extract blockstates, models, and textures. |
| `extract-all --min-version <id>` | Extract assets for every release at or above a version. |
| `generate-biomes --version <id>` | Generate `biomes.json` with sky, fog, water, grass, and foliage color data. |
| `generate-dimensions --version <id>` | Generate `dimensions.json` for the standard dimensions. |

## Runtime APIs

- Chunk payloads are served as MessagePack. The single-chunk endpoint is available at `/api/worlds/:world/:dim/chunk/:cx/:cz`, and the viewer uses the batch endpoint `/api/worlds/:world/:dim/chunks`.
- Texture loading supports both individual PNG requests and a generated atlas mode. The viewer first requests `/api/assets/atlas` and falls back to individual textures if atlas generation fails.
- The worker receives transferable binary chunk buffers and builds typed-array mesh buffers for return to the main thread.

## Current Limits

- Only 1.18+ chunk sections using `sections` and `block_states` palettes are supported.
- Entities and block entities are not rendered.
- Biome tinting is sampled per block; radius blending is not implemented yet.
- If stored light is missing, fallback lighting is baked per column and may have subtle chunk-boundary seams.
- Fluid rendering approximates vanilla levels and neighbor seams but does not simulate animated flow textures.
