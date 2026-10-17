# Depth-binned transparency

[Back to README](../README.md)

The web viewer uses one WebGL2 depth-binned order-independent transparency (OIT) pipeline. Terrain `translucent` and `specialTranslucent`, depth-tested overlay walls, curves, images and alpha-blended GLB materials participate in the same per-pixel transmittance function. There is no sorted-transparency mode, toggle or legacy fallback. Unsupported GPU capabilities fail initialization with an explicit error.

## Algorithm

This independently implemented WebGL2 pipeline follows the depth-bin approach introduced after Minecraft 26.3's wavelet implementation in [26.4 Snapshot 1](https://www.minecraft.net/en-us/article/minecraft-26-4-snapshot-1). The earlier [transmittance-first explanation](https://osor.io/OIT) describes separating transmittance generation from surface shading.

1. Render background, opaque and cutout geometry into a color target with a sampled depth texture. Explicitly marked sky objects retain their background blending.
2. Render translucent geometry against opaque depth. MAX blending records each pixel's minimum/maximum linear view depth and nearest fully opaque translucent surface. The projection inverse handles perspective and orthographic cameras.
3. Convert alpha to optical thickness, `-log(max(1-alpha, 1e-6))`. Add a ramp into sixteen cumulative depth samples in four RGBA16F attachments. Surfaces behind a fully opaque fragment are rejected.
4. Shade transparent surfaces using the interpolated thickness in front of them, correcting for each fragment's own contribution. Accumulate premultiplied color and alpha. Terrain skips lighting, fog and region-mask work in the two alpha-only phases.
5. Derive total coverage from the last depth sample, normalize accumulated color to that coverage and composite over the background. Copy opaque depth to the destination.
6. Draw explicitly depth-disabled annotations in their established order. Terrain area masks remain a separate ordered operation applied by the terrain shaders.

Built-in material output encoding and the custom terrain output convention are retained: unoccluded opaque colors do not change or receive a second transfer. Blending follows the viewer's existing display-space convention; this is not a change to a physically linear lighting pipeline.

Variants share original shader uniforms, animation textures and per-object callbacks. Source disposal releases variants; material version changes rebuild them. Temporary material substitutions, background, target, clear state and renderer-info settings are restored on exceptions. Render errors stop the animation loop and reach the viewer error display. Disposal releases all targets and variants.

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

Targets retain aspect ratio and are capped at 3,145,728 pixels: 192 MiB before driver overhead. Larger canvases receive an upscaled composite; depth-disabled annotations draw at destination resolution. At 960×720 the targets use 44,236,800 bytes (42.19 MiB). Meshes, assets, masks, the canvas and renderer lookup textures are additional allocations.

## Rendering acceptance

Run `pnpm test:transparency`. An isolated production build writes screenshots and `results.json` to `LOCAL_render_acceptance/transparency/`. Ordinary production builds exclude fixtures. `pnpm test:overlays` uses this renderer for API-delivered images, GLB, masks, walls and curves. CI runs both.

The synthetic world uses the real `ModelBaker` and `meshSection`: four sections, 1,924 blocks and 2,472 triangles. Ground, red/blue glass crossing chunk boundaries, water, a rotated special translucent model and a green overlay wall exercise intersecting materials.

Measured 2026-10-18 on Apple M3 / macOS / Chrome 155.0.8059.80 / ANGLE Metal, at 960×720, DPR 1:

- Perspective and orthographic world images changed by at most 1/255 per channel after reversing object and triangle submission order. Screenshot review confirmed glass, water and intersecting models remain visible.
- Pixel assertions cover 50% alpha, separated and intersecting layers, opaque occlusion, depth-disabled annotations, alpha 0/1, dynamic visibility/opacity/color, texture alpha and cutout holes. A real GLTFLoader-decoded alpha-blended GLB and a direct MeshStandardMaterial check exercise lit materials.
- Opaque color matches a direct-render reference exactly. A deliberately failing material callback verifies state restoration.
- A 3840×2160 canvas produces capped 2364×1330 targets (201,223,680 bytes). Shrinking releases the larger allocation.
- Five world load/unload cycles return to two geometries, nine textures and four programs, with one variant owner. Complete disposal leaves zero geometries and one renderer-owned BRDF lookup texture, released with the renderer.
- Missing float-blend support produces the explicit capability error without another rendering path.

The report records CPU submission times, not GPU time or FPS. This small world is a correctness and ownership fixture, not a large-world throughput benchmark.
