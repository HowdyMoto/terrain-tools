# Ocean, lakes and ponds

**Status: design target, updated 19 October 2026; implementation under refinement.** See the [water guide](WATER.md) for implemented controls and current limitations. Ocean/local-body authoring, directional waves, depth optics, screen-space reflections, terrain foam, wet banks, approximate shallow caustics, reactive temporal handling and basic underwater attenuation are implemented. The web-ocean spectral simulation/foam option was added on 19 October. Planar reflections, physically focused caustics, richer shape tools and water motion vectors remain pending. This specification describes the intended complete system. The visual target is convincing water in a dense landscape at 1920 × 1080 on the dedicated RTX 5060, with a whole-scene target of 30 FPS.

## Artist workflow

The Water tool opens with **Sea level**, **Show ocean**, and a list of named water bodies. Sea level remains an authored world elevation even when the ocean is hidden. Hiding the ocean does not hide lakes or ponds. Selecting a body exposes **Shape / Appearance / Waves / Shore** pages; the body selector stays visible across pages.

For an ocean, set sea level, enable Show ocean, and choose a preset. Water extends to the visible horizon beyond the terrain. Within the terrain, it floods submerged areas connected to the terrain boundary. An isolated depression below sea level stays dry until the artist adds a lake or pond. An advanced ocean exclusion tool supports deliberate exceptions.

For a lake or pond, choose **Fill basin**, click inside a depression, and raise its level with a handle or numeric field. The preview shows the connected flooded area. If water reaches an open terrain boundary, a hole, or a low saddle leading outside the selected basin, show the spill elevation and highlight the escape route. Do not silently turn a pond into an ocean: retain the last bounded preview and require an explicit choice to expand its extent or use a drawn outline.

**Draw outline** creates an independently bounded body for pools, designed ponds and lakes whose banks are not finished. Click to add points, Enter to finish, and Escape to cancel; then drag points or insert/remove them. Terrain above the surface remains dry. Display exposed vertical edges as an authoring warning when an outline ends over low ground. Offer a separate, undoable **Carve basin** operation with depth and bank softness; creating water alone does not reshape terrain.

Every body has a name, visibility, elevation and duplicate/delete actions. Outline edits, elevation drags and preset applications each produce one undo step. Inactive bodies remain selectable from the list without intercepting normal terrain painting. Water editing is disabled during first-person navigation.

### Controls

| Page       | Main controls                                                                    | Advanced controls                                                         |
| ---------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Shape      | Sea level or body elevation in metres; ocean visibility; fill basin/draw outline | Outline points, exclusion regions, spill preview                          |
| Appearance | Preset, visibility distance in metres, water tint, surface roughness             | Absorption color, scattering color and strength, shallow-color adjustment |
| Waves      | Swell height, swell length, direction; local wave strength; ripple strength      | Swell period readout, choppiness, directional spread, link to world wind  |
| Shore      | Shore foam amount and width in metres; wet bank amount                           | Foam breakup and decay, crest whitecaps, shallow caustics                 |

Presets are **Clear tropical**, **Calm lake**, **Forest pond**, **Muddy water**, and **Open ocean**. They set ordinary editable parameters, not separate materials with incompatible controls. Calm ponds start with small ripples and little or no foam. Clear tropical water starts with long visibility, restrained color and a readable bottom; its appearance still depends on seabed material, depth and lighting.

Keep reflection resolution, simulation resolution and other rendering controls in a separate **Quality** disclosure. Changing a quality setting must not change the authored water level, color or wave scale.

## Surface geometry and water extent

Use a camera-following ocean grid with nested levels of detail, stitched edges and increasing cell size toward the horizon. Snap grid movement to cell boundaries, but evaluate waves and surface textures in world coordinates so neither swims with the camera. Cover the visible frustum and fade the distant surface into the same atmosphere as the scene. Recalculate bounds for displaced waves so frustum culling does not remove their crests.

Lakes and ponds use bounded, adaptively subdivided meshes. Both ocean and finite surfaces consume a common terrain height field and water-extent masks. Match the terrain's actual triangle interpolation, including its diagonal convention; bilinear height sampling can put foam and water on the wrong side of a sloping bank. Resolve fine shoreline contact against the opaque scene depth as well, allowing rocks and props to interrupt the water surface.

Cache basin connectivity and shoreline distance fields. Sculpting, holes, body outlines and level changes invalidate the affected regions; rebuild large masks in a cancellable worker job. During a sculpt stroke, use the current terrain height texture for immediate contact clipping and update connectivity when the stroke commits. Show a pending shoreline preview if topology is still being prepared.

Treat terrain holes as open boundaries for basin filling. Outside the height field, the ocean has an unknown, effectively deep bottom; do not clamp the edge terrain height outward. Drawn bodies may overlap, but the highest valid surface wins at each horizontal position. Warn about different-level overlap and clip lower surfaces to avoid doubled transparency. Bodies at the same elevation need a deterministic ownership rule rather than z-fighting.

## Waves, optics and shore detail

### Wave motion

Separate long swells, wind-driven waves and fine ripples. Displace geometry for silhouettes and larger waves; put detail smaller than a mesh cell into filtered normals. Swell height is crest-to-trough height in metres. Wavelength and period must be coupled through the selected wave model, with period shown as a readout unless the artist chooses to author it instead. Local wind can follow the existing Wind settings or use a per-body override.

Start with a deterministic set of directional Gerstner waves and independent small-scale normal detail. Bound aggregate steepness so horizontal displacement cannot fold the surface. Derive normals from the displaced surface rather than overlaying unrelated normal motion. This separation of geometry and fine detail, and the steepness constraint, follows [NVIDIA's physical-model water treatment](https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-1-effective-water-simulation-physical-models).

The ocean quality target includes a GPU spectral wave option with multiple spatial scales, directional spreading and crest compression for whitecaps. Implement it behind the same wave-provider interface after measuring the first renderer. Evaluate whether it improves the actual coastal views enough to justify its cost. Gerstner waves remain appropriate for finite bodies and a cheaper quality tier. All providers share stable seeds, time, displacement bounds and shoreline attenuation. Waves fade in shallow water; this is an artistic shallow-water approximation, not a breaking-wave fluid simulation.

### Ocean reference assessment — 18 October 2026

**Updated 19 October 2026:** following the native WebGPU migration, the web-ocean FFT and world-space foam kernels are adapted into our existing water material on the same GPU device. Standard waves remain available; GodotOceanWaves remains research only. The table describes the upstream references. See [implemented controls and differences](WATER.md#choose-an-ocean-renderer).

| Reference and pinned revision                                                                                            | Useful techniques                                                                                                                                           | Integration requirements                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [web-ocean](https://github.com/noniv/web-ocean/tree/a07c7fd522ef0a897601c114f927a49d93d95520), Maksymilian Dendura       | Six 256² FFT cascades; JONSWAP wind sea plus independent swell; filtered slope moments for distant highlights; compression-driven foam with drift and decay | A complete standalone WebGPU/WGSL renderer with its own device, sky, camera and postprocessing. Its FFT and foam kernels now run on our native WebGPU renderer; our own water shading, sky and postprocessing remain in use. |
| [GodotOceanWaves](https://github.com/2Retr0/GodotOceanWaves/tree/a171446f8174348895aaafc426576c26261058b9), Ethan Truong | Finite-depth TMA spectrum, adjustable directional spreading, cascades, foam accumulation and scheduled simulation updates                                   | Godot RenderingDevice, GDScript, GLSL compute and spatial shaders require a port. The reviewed generator fixes spectrum depth at 20 m; it does not derive bathymetry from our terrain.                                       |

Source details: web-ocean's [simulation and persistent foam](https://github.com/noniv/web-ocean/blob/a07c7fd522ef0a897601c114f927a49d93d95520/js/wgsl/sim.js), [surface shading](https://github.com/noniv/web-ocean/blob/a07c7fd522ef0a897601c114f927a49d93d95520/js/wgsl/ocean.js) and [renderer lifecycle](https://github.com/noniv/web-ocean/blob/a07c7fd522ef0a897601c114f927a49d93d95520/js/main.js); Godot's [spectrum](https://github.com/2Retr0/GodotOceanWaves/blob/a171446f8174348895aaafc426576c26261058b9/assets/shaders/compute/spectrum_compute.glsl), [generator](https://github.com/2Retr0/GodotOceanWaves/blob/a171446f8174348895aaafc426576c26261058b9/assets/water/wave_generator.gd) and [water shading](https://github.com/2Retr0/GodotOceanWaves/blob/a171446f8174348895aaafc426576c26261058b9/assets/shaders/spatial/water.gdshader). Neither supplies our terrain-connected flooding, local water bodies, shore contact, transparent seabed or authoring integration. Spectral waves alone also do not provide physically breaking beach surf.

Both repositories have MIT licenses: [web-ocean notice](https://github.com/noniv/web-ocean/blob/a07c7fd522ef0a897601c114f927a49d93d95520/LICENSE), copyright 2026 Maksymilian Dendura; [GodotOceanWaves notice](https://github.com/2Retr0/GodotOceanWaves/blob/a171446f8174348895aaafc426576c26261058b9/LICENSE), copyright 2024 Ethan Truong. Any distributed port must include the applicable full license/copyright notices and credit its origins. Godot also credits Takuya Okahisa's MIT OTFFT work and Jarod Guest's CC0 sky; preserve applicable third-party notices when selecting code or assets. The reviewed source snapshots and their original licenses are isolated under `.qa/ocean-research/`; the adapted web-ocean compute kernels are now included in production bundles, with full MIT notices in source, public/licenses and lib/licenses. No upstream demo assets or Godot code are bundled.

#### Artist controls and remaining proposals

Keep one water inspector and offer choices that describe the result:

- **Wave model:** Lightweight (existing directional waves) or web-ocean spectral (implemented optional provider). Keep Lightweight available for ponds, previews and lower cost.
- **Sea state:** Calm, Coastal swell, Open ocean, Rough sea. These presets edit wave settings; existing appearance controls independently set tropical clarity, murkiness and tint.
- **Waves:** wind speed/direction or Follow world wind, wind travel distance (fetch), swell significant height and peak wavelength, direction, spread and choppiness. Label significant height explicitly; it is not identical to the current crest-to-trough height control.
- **Shore:** retain shore width/amount and add independent crest whitecaps, foam lifetime and drift. Accumulated foam determines where patches persist; the existing fine pore texture supplies their close-up detail.
- **Quality:** simulation resolution and spatial scales, reflection quality and foam coverage resolution. Changing quality retains physical wavelengths, height, water elevation and color.

Show the upstream authors in credits. A future advanced spectrum choice can distinguish deep-water JONSWAP and finite-depth TMA once both are implemented and tested. Repository names need not become competing, incompatible material controls.

#### Integration experiment and acceptance

The implemented provider uses six FFT cascades at 128² (Balanced) or 256² (High), with two ping-pong world-space foam layers at 256² or 1024². GPU textures remain on the renderer's native device. Wave fields enter the existing TSL water material; there is no second canvas or CPU texture transfer. A mesh-spacing filter prevents unresolved displacement from aliasing across the coarse distant grid. The complete upstream adaptive ocean mesh and anisotropic sun shading are not ported.

Define a provider contract for displacement, slope/normal, compression, maximum displacement bounds, stable seed/time and disposal. Add world-space foam history with separate shore-contact and crest sources, deterministic clearing after teleport/provider change, and shallow-water attenuation. Stage new resources before committing a provider change; unsupported capabilities or allocation failure retain the previous live water and saved settings. Old documents default to their existing model. Save model/seed/physical parameters, regenerate GPU state, and preserve undo, autosave, native round trips and the documented static-export limitations.

Measure incremental GPU time and memory in the existing 7,323-plant tropical scene at 1080p on the RTX 5060, using the 4–6 ms/96 MiB proposed water budget below. Check close shore foam, grazing-angle shimmer, camera motion, paused/time-resumed simulation, independent body elevations, night lighting, context restoration and failed preparation followed by retry. The user-requested spectral option is available with targeted correctness/recovery coverage. Dense-forest incremental GPU timing, full memory including captures, night/teleport stress and context restoration with this provider remain acceptance work; the option is not a statement that these budgets pass.

#### Local reference validation

The unmodified pinned web-ocean HTML ran in temporary headless Chrome 155.0.8059.82 at 1920 × 1080 with no captured page, shader or device errors. Its actual WebGPU adapter reported NVIDIA/Blackwell and no fallback; the DXGI inventory identifies the workstation's sole NVIDIA adapter as the RTX 5060 Laptop GPU. The default sunset and a stronger daytime wind case both reported 60 FPS. Ten one-second HUD samples per case reported GPU ranges of **7.40–7.67 ms** and **8.23–8.56 ms**, respectively. Those are the demo's smoothed timestamp measurements for its own simulation, ocean, sky and postprocessing, not our incremental water cost or sustained frame-time distributions. Screenshots were inspected; the daytime case retains the demo's default exposure and is visibly bright, underscoring the need to integrate with our lighting controls.

See [source pin, parameters, adapter evidence and samples](benchmarks/ocean-reference-2026-10-18.json). Godot received source/license review only; it was not installed or run. Those historical measurements cover the unmodified demo only. The 19 October integration changes application rendering when explicitly selected and saves optional renderer/spectrum settings; it has no new dense-scene FPS result.

### Reflection, refraction and depth

Water is a dielectric: use zero metalness, an index of refraction near 1.333 and angle-dependent Fresnel reflection. Looking down should reveal a clear shallow bottom; looking across the surface should emphasize reflected sky and scenery. Perform optical calculations in linear light and apply exposure and display tone mapping once at the end.

Use the opaque scene color and depth to refract the view behind the surface. Reconstruct the submerged path length and apply wavelength-dependent absorption plus an approximate in-scattering term. The artist's visibility distance maps to these coefficients using a documented reference attenuation; it is not an alpha slider. Test refracted depth against foreground geometry, reject invalid samples, and fall back to a safe unrefracted sample to prevent bright edge leaks. Opaque scene shadows naturally remain visible through shallow water.

Combine filtered sky/environment reflections with screen-space reflections of nearby terrain and foliage. Fade unreliable screen-space hits into the environment rather than showing black gaps at screen edges. Offer a planar reflection for the most important visible plane when quality and budget permit. Render at most one such plane per frame, hide all water during its capture, clip geometry against the reflection plane, and bound its resolution and foliage detail. Cache other planes with explicit invalidation for camera, lighting and scene changes; they retain the cheaper reflection path when stale.

Sky, sun highlights, atmosphere and reflections follow the existing time-of-day system. A bright sky texture must not override nighttime illumination. Reflection cameras and shadow selection need explicit handling; reusing the main camera's shadow coverage without checking the reflected frustum can produce incorrect reflected shadows.

### Foam, wet banks and caustics

Shore foam combines water depth, distance to shore, slope, incoming wave phase and a moving breakup pattern. Use distance in metres for the width control, not just vertical depth: the same depth band spans very different distances on a beach and a cliff. Fade patches in after wave contact and let them decay, avoiding a permanent uniform white outline. Separate crest whitecaps use wave steepness/compression and the whitecap control. Treat foam as an opaque-scattering layer over water, reducing transmission and increasing roughness.

A wetness mask darkens exposed terrain near the recent waterline and lowers roughness. It fades with height and distance and follows each body's elevation. Keep wetness a rendering effect unless the artist explicitly bakes it into surface authoring. Add optional projected caustics for clear, shallow, sunlit water, attenuated by depth, turbidity and shadows. These are an approximation; do not brighten deep muddy bottoms or shaded banks indiscriminately.

When the walkthrough camera enters a water volume, apply underwater attenuation and a stable surface transition. Determine the active volume from extent, elevation and terrain, not sea level alone. Avoid inverted backfaces and a sudden clear view beneath a surface. Swimming and buoyancy can consume future water-height queries; they are not prerequisites for authoring or rendering this system.

## Renderer and project integration

Use one shared opaque capture for all bodies. Water must be absent from opaque depth/contact shading and must never sample a texture still attached to the active draw target. Integrate with the existing contact-shading depth reuse rather than rendering the entire forest again for every pond.

The frame order is: sun/shadows and any scheduled reflection capture; opaque scene with contact shading; water using resolved opaque color/depth; underwater attenuation when applicable; temporal resolve and output. Preserve HDR through compositing. Add a water coverage/reactivity mask to reduce temporal history on moving waves, foam and disocclusions, while retaining useful stabilization in calm regions. Camera jitter, perspective/orthographic depth, resize and device pixel ratio must agree across passes.

Proposed module responsibilities:

| Module                                            | Responsibility                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| `src/core/water.ts`                               | Typed settings, normalization, presets, stable IDs and extent validation        |
| `src/core/water-bodies.ts`                        | Basin connectivity, polygon validation and terrain-relative extent calculations |
| `src/runtime/water.ts`                            | Prepared surfaces, cached masks, wave providers and resource lifetime           |
| `src/runtime/water-material.ts`                   | Displacement, optical shading, foam and wetness inputs                          |
| `src/runtime/water-pass.ts`                       | Shared captures, reflection scheduling and water compositing                    |
| `src/editor/water-controls.ts` / `water-tools.ts` | Inspector controls, outline handles and cancellable previews                    |

`TerrainScene` owns prepared water resources. `TerrainEnvironment.render(camera)` coordinates its passes so runtime hosts and the editor agree. `Viewport` handles picking and authoring overlays. Restore render targets, viewport/scissor, camera layers, scene visibility and shadow state even if a pass fails. Release replaced resources and invalidate temporal/reflection history when needed.

### Persistence and compatibility

Add optional `TerrainProject.water` with its own `schemaVersion: 1`, `seaLevel`, ocean settings, and named body records. Each body contains a stable ID, enabled state, elevation, extent definition, wave seed and appearance/wave/shore settings. Store artist intent; regenerate meshes, connectivity caches and GPU textures. Validate finite values, polygon bounds, non-self-intersection and allocation limits before preparing resources.

For a document without `water`, resolve the existing `view.water` and `view.waterLevel` as the legacy plane. Do not silently upgrade its look on load. Its first explicit conversion to the new system creates the new settings. Once present, `water` is authoritative; write legacy visibility/elevation mirrors for older readers and route compatibility setters through the same normalization. The new reader must not alternate between two sources of truth.

Native `.terrain` packages, JSON, autosave and authoring data embedded in GLB retain all settings. A normal GLB export gets bounded static surface meshes and a portable approximation of the material; it cannot reproduce the runtime ocean shader or camera-dependent reflections. Preserve exact reconstruction through the native authoring extension. Terrain resize scales outlines horizontally and elevations when **Scale elevation with size** is enabled; wavelengths, clarity and foam width remain metres unless explicitly rescaled.

### Transactional authoring

Uniform-only changes can preview immediately. For outline changes, topology, quality allocation or basin rebuilding, stage all fallible CPU/GPU preparation before creating a history checkpoint or changing the committed document. Commit the document and live resources together. Cancellation, stale worker results, allocation failure and shader preparation failure must preserve the previous scene, selection, undo/redo and autosave. Release abandoned candidates. A successful retry must work without reloading the application.

## Performance targets and delivery

These are proposed budgets, not measurements or a photorealism claim. Benchmark on the actual RTX 5060 in Chrome at a 1920 × 1080 drawing buffer. The integrated Radeon 860M is not the target. Keep the existing one-pending-frame input scheduler.

Reserve an initial **4–6 ms incremental GPU budget** and **under 1 ms steady-state CPU work** for water in a representative forest view. A 30 FPS scene has 33.3 ms total; if the existing landscape already uses that time, quality must be reduced elsewhere or the water path optimized. Start with half-resolution screen-space/planar reflections, shared captures, bounded reflection updates and no synchronous GPU readback. Track water-specific GPU memory with an initial 96 MiB ceiling at 1080p, including simulation, masks and captures. Allocation formats and sharing determine the measured total.

Deliver in four reviewable stages:

1. **Authoring and compatibility:** sea level independent of ocean visibility, ocean extent, bounded bodies, presets, serialization, undo/cancel and legacy loading. Establish deterministic geometry and failure tests before visual complexity.
2. **Coastal rendering:** displaced swells/ripples, depth-dependent absorption/refraction, sky and screen-space reflections, contact foam and wet banks. Review clear tropical water and a murky pond against reference images in matched lighting.
3. **Scene integration:** budgeted planar reflections, underwater transition, caustics, spectral ocean evaluation, stable temporal rendering and dynamic daylight. Verify multiple elevations and dense foliage.
4. **Measured tuning:** profile shoreline close-ups, open horizon, multiple lakes and tropical forest walkthroughs. Tune quality tiers against both image quality and frame-time distributions before setting defaults.

Acceptance requires more than a still image:

- Sea level survives ocean hiding, saving and reopening; independent ponds remain visible at their own elevations.
- Moving and rotating the camera exposes no finite ocean edge, grid seams, sliding texture coordinates or folded waves.
- Shallow clear water shows the bottom, deeper water loses visibility gradually, and grazing views reflect the scene convincingly.
- Terrain sculpting, holes, body edits and undo update the correct shoreline without flooding unrelated depressions. Foam moves and breaks up; calm water can have none.
- Foreground objects, screen edges, sunset, night, submerged cameras and overlapping bodies have defined, stable behavior.
- Native round trips preserve body IDs/settings; legacy documents retain their appearance; portable GLB limitations are documented.
- Injected preparation failures and cancellation preserve document, GPU resources, history and autosave, followed by a successful retry.
- Report actual adapter, browser, drawing-buffer size, visible bodies, scene density, GPU memory, incremental pass times, and median/p95 frame intervals. Check camera responsiveness with water enabled; a favorable average FPS alone is insufficient.
