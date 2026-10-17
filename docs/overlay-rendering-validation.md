# Overlay rendering validation

[Back to overlays](overlays.md)

## Run the browser checks

```sh
pnpm build
pnpm exec playwright install chromium
pnpm test:overlays
pnpm test:transparency
```

The overlay suite builds an isolated production viewer and starts temporary API/storage fixtures. On macOS it uses installed Google Chrome by default; set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to use another Chromium executable. Tests do not seed annotations into a production world.

Overlay screenshots and `browser-results.json` are written to ignored `LOCAL_railway_deploy/overlay-acceptance/`. Synthetic-world screenshots and `results.json` are written to `LOCAL_render_acceptance/transparency/`. Ordinary production builds exclude test harnesses. Keep reports local or attach selected artifacts to a review; committed documentation describes contracts and reproduction rather than individual runs.

## Rendering contracts

| Area | Assertions |
| --- | --- |
| Terrain masks | Full-detail, tiled, LOD and offline top-map materials sample the same world-XZ field across terrain heights and both top projections. Opacity 0/1 and ordered partial overlaps retain their defined semantics. |
| Player walls | Extrusion uses declared heights, displays from both sides, obeys solid occlusion by default, and overpaints only with `occlusion: always`. |
| Transparent intersections | Water, depth-tested walls, curves, images and alpha-blended models share [depth-binned OIT](transparency.md). Changing object/triangle order must not change visibility; finite-bin color reconstruction remains approximate. |
| Curves | Dense projected samples check the subdivision tolerance, CSS-pixel widths stay constant and block widths vary with distance. Point/depth budgets and eye-plane degradation are exercised. |
| Media | PNG/JPEG/WebP/SVG tests check orientation, transparent borders, anchoring and explicit aspect ratios through the real API and CLI. Static GLB tests check transforms, lighting, shared resources and lazy loading. |
| Context and ownership | Disabled/offscreen content releases media and masks; canceled or stale downloads cannot resurrect an obsolete context. Shared versions remain loaded until their last owner leaves. Repeated cycles return renderer counts to the captured baseline. |
| Viewer integration | Production `/map/` builds exercise controls, real media, deferred GLB loading, static/API prefixes and servers without overlay capabilities. |

The dedicated transparency suite uses the actual mesher to build a four-chunk synthetic world with cross-chunk glass, water and a special translucent model. It verifies both camera projections, actual changed draw sequences, pixel alpha/occlusion, texture cutouts, GLTFLoader alpha blending, allocation limits, error-state restoration and disposal. See [the pipeline guide](transparency.md) for GPU requirements and memory accounting.

## Resource and performance comparisons

The overlay fixture uses a fixed camera path: orthographic sweep, perspective sweep, leave view, return. Baseline, typical and pressure scenes exercise feature selection, shared assets and the display budget. Resource limits come from `packages/web/src/render/overlayLimits.ts`; OIT attachments have a separate [bounded allocation](transparency.md#requirements-and-memory).

Reports include CPU submission time, browser-paced frame intervals, network requests, approximate JS heap, estimated media/mask bytes and renderer object counts. CPU measurements include overlay update and rendering submission; they exclude initialization and mesh workers. GPU memory estimates omit driver overhead. Small media fixtures do not bound arbitrary model complexity.

Use `VIOLET_REFERENCE_PERF=1 pnpm test:overlays` only on a comparable reference machine to enforce the CPU/frame envelopes described in [release acceptance](overlay-release-acceptance.md). Other environments still enforce correctness and resource/lifecycle assertions. Record browser version, GPU/backend, viewport, DPR and concurrent workload when comparing results; these checks do not imply portable FPS or zero stutter.

Review the mask, wall/water, curve, image, GLB and synthetic-world screenshots after changing shaders or rendering passes. Inspect pixel assertions and raw reports alongside the images; a screenshot alone cannot establish order invariance or resource release.
