# Depth-binned transparency

[Back to README](../README.md)

The web viewer uses one WebGL2 depth-binned order-independent transparency (OIT) pipeline. Terrain `translucent` and `specialTranslucent`, depth-tested overlay walls, curves, images and alpha-blended GLB materials participate in the same per-pixel transmittance function. There is no sorted-transparency mode, toggle or legacy fallback. Unsupported GPU capabilities fail initialization with an explicit error.

## Algorithm

This independently implemented WebGL2 pipeline follows the depth-bin approach introduced after Minecraft 26.3's wavelet implementation in [26.4 Snapshot 1](https://www.minecraft.net/en-us/article/minecraft-26-4-snapshot-1). The earlier [transmittance-first explanation](https://osor.io/OIT) describes separating transmittance generation from surface shading.

1. Render background, opaque and cutout geometry into a color target with a sampled depth texture. Explicitly marked sky objects retain their background blending.
2. Render translucent geometry against opaque depth. MAX blending records each pixel's minimum/maximum linear view depth and nearest fully opaque translucent surface. The projection inverse handles perspective and orthographic cameras.
3. Convert alpha to optical thickness, `-log(max(1-alpha, 1e-6))`. Add a ramp into sixteen cumulative depth samples in four RGBA16F attachments. Surfaces behind a fully opaque fragment are rejected.
4. Shade transparent surfaces using the interpolated thickness in front of them, correcting for each fragment's own contribution. Accumulate premultiplied color and alpha. Terrain skips lighting, fog and region-mask work in the two alpha-only passes.
5. Derive total coverage from the last depth sample, normalize accumulated color to that coverage and composite over the background. Copy opaque depth to the destination.
6. Draw explicitly depth-disabled annotations in their established order. Terrain area masks remain a separate ordered operation applied by the terrain shaders.

Built-in material output encoding and the custom terrain output convention are retained: unoccluded opaque colors do not change or receive a second transfer. Blending follows the viewer's existing display-space convention; this is not a change to a physically linear lighting pipeline.

Variants share original shader uniforms, animation textures and per-object callbacks. Source disposal releases variants; material version changes rebuild them. Temporary material substitutions, background, target, clear state and renderer-info settings are restored on exceptions. Render errors stop the animation loop and reach the viewer error display. Disposal releases all targets and variants.

The owning scene updates world matrices once per frame. Opaque, transparent and foreground passes traverse filtered, non-owning views of its drawables, retaining original parents, nested world transforms, group ordering and lights. Material selection is cached until the source material or its rendering flags change. Empty transparent and foreground passes are skipped. WebGL context restoration invalidates framebuffers and shader programs before rendering resumes.

This is approximate OIT: nearby surfaces within finite depth bins can mix colors, and half-float sums can vary slightly with submission order. Attachment memory is independent of layer count, but transparent overdraw still costs time. Opaque LOD and offline top-map representations retain their existing limitations.

## Requirements and memory

WebGL2 must expose `EXT_color_buffer_float`, `EXT_float_blend` and four draw buffers/color attachments. Framebuffer completeness is checked initially and after resizing.

| Buffer                                     | Format                         | Bytes/pixel |
| ------------------------------------------ | ------------------------------ | ----------: |
| Opaque color and depth                     | RGBA8 + unsigned integer depth |           8 |
| Linear bounds and opaque transparent depth | RGBA32F                        |          16 |
| Sixteen cumulative depth samples           | 4 × RGBA16F                    |          32 |
| Weighted color/alpha                       | RGBA16F                        |           8 |
| Total                                      |                                |          64 |

Targets retain aspect ratio and are capped at 1,572,864 pixels: 96 MiB before driver overhead. Larger canvases receive an upscaled composite; depth-disabled annotations draw at destination resolution. At 960×720 the targets use 44,236,800 bytes (42.19 MiB). Meshes, assets, masks, the canvas and renderer lookup textures are additional allocations.

## Rendering acceptance

After `pnpm build`, run `pnpm test:transparency`. An isolated production build writes screenshots and `results.json` to `LOCAL_render_acceptance/transparency/`. Ordinary production builds exclude fixtures. `pnpm test:overlays` uses this renderer for API-delivered images, GLB, masks, walls and curves. CI runs both.

The synthetic world uses the real `ModelBaker` and `meshSection`: four sections, 1,924 blocks and 2,472 triangles. Ground, red/blue glass crossing chunk boundaries, water, a rotated special translucent model and a green overlay wall exercise intersecting materials.

The suite verifies:

- Perspective and orthographic world images remain within a small per-channel tolerance after both object submission order and triangle order are reversed. Actual renderer callbacks record the submission sequences so the test cannot pass without changing draw order.
- Pixel assertions cover single-layer alpha, separated/intersecting layers, opaque occlusion, explicitly depth-disabled annotations, alpha 0/1, dynamic material state, texture alpha and cutout holes.
- Fully occluded distant surfaces cannot expand the visible depth-bin range and change front-layer colors. The nearest fully opaque transparent depth also limits the normalized range.
- A generated alpha-blended GLB is decoded by the real GLTFLoader and rendered with MeshStandardMaterial.
- Opaque color matches a direct-render reference. A failing material callback restores object and renderer state.
- High-resolution allocation obeys the pixel/byte limit, shrinking releases the larger allocation, and repeated world load/unload cycles return to the same baseline. Renderer-owned lookup textures are accounted separately from pipeline ownership.
- Background point sprites retain their screen size when the scene target is downscaled, with or without perspective size attenuation.
- Missing float-blend support reports an explicit capability error without starting another rendering path.
- Nested drawables and lights keep their ownership and world transforms, including when a callback throws. Actual context loss and restoration reproduce the pre-loss pixels and release all pipeline allocations on disposal.

Inspect the generated perspective and orthographic PNGs for missing surfaces, overlap colors and seams at chunk boundaries. The JSON records browser/GPU identity, pixel differences, allocation estimates, lifecycle counts and CPU submission timings. Record hardware, viewport and DPR when comparing reports. CPU submission time is not GPU time or FPS; this small world validates correctness and ownership rather than large-world throughput.
