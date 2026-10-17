# Viewer, assets, and local worlds

[Back to README](../README.md)

## Assets and local worlds

Extract client assets (only use Minecraft assets you are entitled to use):

```bash
pnpm violet-map assets extract --version 1.21.4 --dir data/assets
```

The server default expects worlds under `data/worlds/<world-name>/`. Set `WORLDS_DIR` to use another directory. Region files can also be uploaded through Admin.

```text
<world>/
├── level.dat
├── region/r.<x>.<z>.mca
├── DIM-1/region/…
├── DIM1/region/…
└── dimensions/<namespace>/<path>/region/…
```

Additional packs are supplied with `ASSETS_DIRS=base,override`; later paths take precedence.

Block metadata in `block-overrides.json` distinguishes `occludes` (a solid model can block light and section visibility) from `cullSameBlock` (touching faces of the same block id may be removed despite texture alpha). Glass, connected glass panes and ice enable the latter; leaves keep their internal faces. Different stained-glass colors retain their shared border. Partial models must cover the actual shared boundary before they can remove another face. Replacing textures alone does not turn a porous block into a solid occluder.

## Viewer and asset tooling

The viewer persists its selected world, camera, scheduler, diagnostics, and settings in local storage. The **Settings** tab includes **Enable IndexedDB cache**. Disabling it bypasses all mesh-cache reads and writes without deleting existing cache data; clear it explicitly if desired. Viewer initialization errors appear in the center of the screen so the tabs never obscure them.

The web UI uses native Preact controls and CSS Modules. Shared loading, capabilities, settings and diagnostics are coordinated through signals. The canvas is mounted in a separate `#viewport` outside the UI's `#root`; changing panels, languages or settings does not recreate the renderer. URL settings override saved values for the current session without overwriting those saved values. Clip ranges are saved separately for each dimension. Failed world-list requests show a retry action, and keyboard shortcuts remain available in form controls while camera movement consumes its own browser shortcuts.

```bash
pnpm violet-map --help
```

| Command | Description |
| --- | --- |
| `assets list` | List available Minecraft releases. |
| `assets extract --version <id> --dir <dir>` | Download a Mojang client jar and extract blockstates/models/textures. |
| `assets extract-all --min-version <id> --dir <dir>` | Extract every selected release. |
| `assets generate-biomes --version <id> --output <file>` | Generate biome color data. |
| `assets generate-dimensions --version <id> --output <file>` | Generate standard dimension data. |
| `profile-mca <file.mca>` | Profile region parsing and meshing. |
| `bake-topmap <world>` | Bake top-map tiles and manifest under `.violet-map/top-map`. |
| `world sync …` | Sync a local archive to local/S3/server storage with identity protection and shared remote authorization. |
| `users list/create/update/delete` | Manage users via API (default) or explicit database mode. |
| `auth login/whoami/logout` | Save, inspect, or revoke a server login. |
| `profile set/list/use/delete` | Manage named connections. |
| `config paths/show/set` | Inspect locations/settings or choose a credential backend. |
| `credentials set/list/delete/issue/revoke` | Manage local secret references and server-issued credentials. |

`bake-topmap` supports `--approach top|bottom` and `--light-mode stored-first|rebake`.

### Resource-driven special renderers

Animated block and fluid textures use their resource-pack `.png.mcmeta` animation definitions. Special blocks and entities are declared, rather than named in the viewer, in `assets/<namespace>/violet_map/renderers.json`. Each entry points at an ordinary Java model JSON under `models/`, so packs can add geometry without a code change. The bundled registrations illustrate chest and sign block entities.

```json
{
  "blockEntities": {
    "minecraft:example": {
      "model": "minecraft:violet_map/block_entity/example",
      "layer": "cutout",
      "rotationY": { "property": "facing", "values": { "north": 180, "south": 0 } }
    }
  },
  "entities": {
    "minecraft:example_mob": {
      "model": "minecraft:violet_map/entity/example_mob",
      "scale": [1, 1, 1],
      "useEntityYaw": true
    }
  }
}
```

Only registered entities are rendered. There are deliberately no built-in legacy-entity meshes; provide a modern Java-model JSON in the resource pack for each entity that should appear. Resource models are shown only for full-detail chunks in the preset-dependent near radius (potato through extreme).

## Limits

- Rendering targets modern (1.18+) `sections` / `block_states` chunk layouts.
- Biome tinting is sampled per block; radius blending is not implemented.
- Fluid surfaces approximate vanilla flow.

## Independent static hosting

Build web/admin separately and deliver only their `dist` directory. Each loads `runtime-config.json` before mounting its UI (native Preact for web, React for admin); replace `{ "apiBaseUrl": "https://api.example.com/violet/", "capabilityFallback": "legacy" }` to change API without rebuilding JavaScript. Only a missing runtime file uses `VITE_API_BASE_URL` or the origin root fallback. Invalid config, network errors and API 5xx display a retryable startup error; only an explicit capabilities 404 can enable old-server behavior. API credentials are isolated by normalized API URL. The web build explicitly disables React aliases and does not use `preact/compat`.

Build with `VITE_BASE_PATH=/map/` or `/console/` for static subpaths. Runtime config, workers and brand resources use the static base; API prefix is independent. Atlas, individual fallback textures and colormaps support CORS Canvas reads and WebGL uploads. Set the API CORS origins to the browser-visible frontend origins. See [deployment](deployment.md).

Biome edits through `PUT /api/data/biomes` must be an object keyed by biome ID (or `default`). Each definition needs finite numeric `temperature` and `downfall` values and an `effects` object containing `sky_color`, `fog_color`, and `water_color` as integers from `0` to `0xffffff`. Optional grass/foliage colors use the same range; `grass_color_modifier` accepts `none`, `dark_forest`, or `swamp`. Extra fields are retained, and climate values outside 0–1 remain accepted because colormap sampling clamps them. Invalid JSON/schema returns 400, and bodies above the configured upload limit return 413. Successful edits publish a complete JSON file atomically; failed publication leaves the previous file usable.
