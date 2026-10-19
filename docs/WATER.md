# Water authoring and rendering

Terrain Studio supports a camera-following ocean and up to 16 independently elevated ponds or lakes. Water has animated swells and ripples, depth-dependent visibility, sky and screen-space reflections, terrain shoreline foam, wet banks, shallow-water caustics and basic underwater attenuation. The more advanced ocean work in the [design specification](WATER-DESIGN.md) remains a development target.

## Start with an ocean

Open **Water**, select **Ocean**, enable **Show ocean**, and set **Water height (m)**. There is no separate setup button. Height is measured from world zero; raise it above low ground to see water over the terrain.

The inspector has **Shape / Appearance / Waves / Shore** pages. The selected-water list, visibility switch and water height stay visible above every page. Opening the inspector or browsing pages leaves the project unchanged. For older projects, the first water edit adopts the current water system as part of that same undoable change; Undo restores the previous plane and settings.

1. With **Ocean** selected, **Water height (m)** sets sea level. The ocean follows the camera and covers the visible horizon beyond the terrain. Sea level remains saved when the ocean is hidden; ponds and lakes stay visible independently. The Scene panel's **Ocean** On/Off button controls the same ocean visibility.
2. In **Appearance**, choose **Clear tropical**, **Calm lake**, **Forest pond**, **Muddy water**, or **Open ocean**. Presets set editable parameters. Use **Water color**, **Visibility distance**, and **Surface roughness** to refine the result. A shallow, light-colored seabed is part of the clear tropical look.
3. In **Waves**, adjust swell and wave heights/lengths separately, plus direction, speed and fine ripples. **Follow world wind direction** uses the Wind tool's direction; wave amplitude remains independently authored. Speed zero freezes motion.
4. In **Shore**, set foam amount and width in metres. Foam follows terrain contact with drifting patches, centimetre-scale pores, fine froth and subtle surface relief. Its detail automatically filters with viewing distance. Calm ponds can use zero foam. **Wet ground strength** darkens and smooths submerged ground and the adjacent bank; **Wet bank height** sets its vertical fade above mean water. **Caustic light** adds moving light patterns to directly lit submerged terrain. Clear tropical water uses more caustics; muddy water disables them. Each strength can be set to zero independently.

Within the terrain, the ocean fills only areas connected to a submerged boundary. An isolated below-sea-level depression needs its own water body. Connectivity follows the heightfield cells; visible contact uses the terrain's triangle interpolation. Enabling the ocean adds submerged boundary walls using the terrain material, closing the open edges of the heightfield. These are rendering geometry, not added collision. Beyond the heightfield the seabed is unknown and treated as deep water; a finished offshore landscape still needs authored terrain.

## Make a pond or lake

In **Shape**, **Place pond** creates an ellipse where you click terrain. Its initial level is 0.8 m above the clicked ground. Adjust center X/Z, radii and rotation in Shape. Set **Water height (m)** above the pages to change this pond's elevation independently of the ocean. A visible outline helps identify the selected extent. Duplicate creates a separate body at the same position; move its center or edit its outline to separate it.

**Draw lake outline** accepts terrain clicks around the desired footprint. A line previews the outline and cursor position. Press Enter or **Finish outline** after at least three points; Escape or Cancel abandons the drawing. The initial water level is 0.5 m above the lowest clicked point. Refine it numerically. The **Outline coordinates** disclosure edits X/Z pairs, one point per line. Outlines support 3–128 points and must not cross themselves.

**Fill basin** starts a connected fill from the clicked point. It needs a closed terrain depression. A level that escapes through a terrain boundary or hole is rejected with an explanation. The same guard applies when sculpting would open an enabled basin: the failed stroke retains the previous terrain and water. Lower or disable the basin, or replace it with a drawn outline, before opening its banks. Basin topology currently prepares synchronously; very large, complex edits need further responsiveness tuning.

Select a body to rename, hide, duplicate or delete it, set its independent elevation, and change its appearance. Adding water does not excavate the ground. Sculpt a depression first if needed; a drawn boundary over low terrain can have a visibly exposed edge. Higher overlapping water establishes depth first, preventing lower surfaces from showing through it.

While sculpting, the terrain height used by water updates with the brush. Connected water coverage, wet banks and caustics finish updating when you release the stroke. This avoids repeating full-terrain flood and shoreline preparation on every dab. A failed final update restores the previous terrain and water and preserves undo/redo; Escape cancels the preview. Completion still performs synchronous work, and the height texture still uploads in full, so this is an initial responsiveness improvement rather than a complete large-world water solution. See [issue #3](https://github.com/HowdyMoto/terrain-tools/issues/3).

`npm run build` then `npm run benchmark:water-preview` reproduces the CPU comparison at 128, 256 and 512 cells. The recorded 512-cell case improves from 22.52 to 1.76 ms median per regional preview, with 20.83 ms of water preparation still paid on release. This excludes GPU uploads and frame scheduling; it does not establish an interactive frame rate. See [raw results and targeted recovery validation](benchmarks/water-edit-preview-2026-10-18.json).

Values commit on release/change as one undo step. Shape/level and shoreline-field changes prepare resources before committing. Color, roughness, wave shape, ripples and foam reuse existing meshes and textures. Visibility, clarity, wet-bank controls, caustics and animation speed also update the terrain's shoreline field and currently prepare a replacement. Failed preparation preserves the committed document, selection and redo branch, including a failed shoreline texture allocation. Water clicks do not paint terrain, and water editing is disabled in first person.

## Rendering behavior and limits

All visible bodies share one linear HDR scene-color/depth capture. Refraction uses scene depth, rejects foreground samples, and attenuates the submerged view with distance. Water uses dielectric PBR highlights and sky illumination from the existing sun/sky or HDR/EXR setup. The ocean's mesh follows the camera while wave coordinates remain fixed in terrain space.

**Reflect nearby scenery** adds a bounded screen-space reflection trace. Off-screen and missing reflections fall back to the environment. Turning it off retains sky reflections and can reduce cost. Weak reflections at steep viewing angles use the environment; tracing focuses on angles where reflected scenery contributes visibly. Screen-space traces cannot reliably reflect hidden/off-screen trees; planar reflections are not implemented yet. The current refraction offset and optical scattering are approximations, not path tracing.

Six directional geometric waves provide swells and smaller waves, with filtered normal detail for ripples. Steepness is bounded to avoid extreme slopes. This implementation does not yet have a spectral FFT ocean, breaking surf or crest-whitecap simulation. Shore foam and wet-bank effects use the heightfield; arbitrary prop intersections do not receive these effects. The [MIT ocean reference assessment](WATER-DESIGN.md#ocean-reference-assessment--18-october-2026) evaluates web-ocean and GodotOceanWaves and proposes artist-facing wave models; these options are not implemented yet.

Foam detail uses a generated 1024² texture with approximately 4 mm texels over a four-metre repeating tile. Two drifting, rotated layers combine differently sized rounded pores, microfroth and larger patch breakup; normal relief and roughness respond to scene lighting. Mipmaps and anisotropic filtering reduce distant shimmer. The texture is shared by all bodies in a prepared water state (about 5.3 MiB including mipmaps), with cached CPU generation and no external image download. Its detail is independent of terrain grid resolution; the shoreline itself still follows the authored terrain. This is procedural surface foam, not a simulation of breaking waves, foam accumulation or bubbles in volume.

Wet banks extend from connected submerged cells and fade above the water. Isolated dry depressions stay dry, and hiding a body removes its effect. The shoreline field interpolates at terrain-grid resolution; very narrow banks need adequate terrain resolution. Wetness is instantaneous rather than a drying simulation. Caustics are an animated procedural approximation, applied to direct diffuse lighting so unlit ground does not glow. They fade with depth and visibility and freeze with animation speed zero. They are not ray-traced light focusing or a simulation of the individual surface waves. Older water files without these fields retain zero wetness/caustics until changed or given a preset.

The temporal resolve uses a water-specific history cap to reduce trails and softening in moving reflections and foam, while foliage retains its usual stabilization. The cap reuses the HDR color buffer's alpha and needs no extra render pass. It is not a replacement for motion vectors; fast movement can still alias or soften. Underwater attenuation begins when the camera is below a containing body's mean surface and above the terrain. It does not yet follow individual crests at the eye or simulate swimming/buoyancy. The walkthrough remains ground-following.

## Persistence and runtime

Optional `TerrainProject.water` has `schemaVersion: 1`, global sea level, ocean settings, a body list and the scenery-reflection toggle. Settings and outlines live in the native document; generated meshes, masks and scene captures do not. JSON, `.terrain`, autosave, undo/redo and the GLB authoring extension preserve the water settings.

The old `view.water` and `view.waterLevel` remain the source of truth for unconverted documents. After conversion, `water` is authoritative and the editor mirrors ocean visibility/level into the legacy fields. Runtime consumers should update `water` and prepare/apply a replacement when changing its topology. `TerrainScene.update()` advances waves; `TerrainEnvironment.render(camera)` supplies refraction/reflections. A host that renders the scene directly gets the surface material without the shared scene capture.

Terrain resize scales outlines and optional elevations. Optical visibility, wave lengths and foam width retain their metre values. Ordinary GLB presentation exports bounded, tessellated static surfaces with approximate standard materials; the ocean covers only the terrain footprint in that export. The runtime's submerged boundary walls are not included in that static presentation. Its native authoring extension retains the complete editable system.

## Verification

The implementation targets desktop 1920 × 1080 on the dedicated RTX 5060. Performance depends on visible water coverage, foliage density, reflections and existing lighting costs. It is not a claim of CryEngine parity.

```sh
npm run build
npm run lint
npm test -- --testTimeout=15000
npm run test:browser -- tests/browser/water.spec.mjs tests/browser/water-lighting.spec.mjs tests/browser/temporal-aa.spec.mjs tests/browser/material-authoring.spec.mjs tests/browser/navigation.spec.mjs
```

The water tests cover independent settings and native round trips, basin isolation/spill detection, outline validation, resize, abandoned preparation and retry, plus browser authoring, undo/redo and injected GPU texture-allocation failure. Failed body duplication also retains the selected body and succeeds on retry. Use the existing navigation tests to check the first-person path after rendering changes.

The October 17 quality follow-up passed the build, lint, all **284 unit tests** with the documented extended fixture timeout, and **12 distinct Chrome scenarios** across water, water lighting, terrain materials, temporal stabilization and navigation. Rendered checks verify wet banks without changing distant dry land, animated caustics without indirect-light glow, exact legacy restoration, opaque final output and no shader errors. The full browser suite was not rerun. See [current measurements and scope](benchmarks/water-quality-2026-10-17.json) and the [earlier implementation evidence](benchmarks/water-system-2026-10-17.json).

The October 18 controls update passed build, lint, **9 water unit tests** and **14 targeted Chrome scenarios** with the RTX 5060 test launcher. Checks cover visible height and switches on every Water page, independent ocean/pond settings, native save/reload, undo/redo, failed GPU/history preparation, retained live physics, compact layout and foliage authoring. The environment/foliage recovery scenario passed unchanged on retry after its exact-image comparison differed by one color level in one pixel. The full browser suite and performance benchmarks were not rerun for this interface change.

```sh
npm test -- tests/water.test.ts
npm run test:browser -- tests/browser/water.spec.mjs tests/browser/compact-inspector.spec.mjs tests/browser/settings-recovery.spec.mjs tests/browser/foliage.spec.mjs
npm run test:browser -- tests/browser/foliage-recovery.spec.mjs --grep "separates environment tabs"
```

The subsequent foam detail update passed build, lint, all **284 unit tests** with `--testTimeout=15000`, and **five Chrome scenarios** across `water-foam`, `water`, `water-lighting` and `temporal-aa`. The new rendered fixture checks fine shoreline detail, identical output on one-metre and four-metre terrain grids, temporal detail retention, paused/animated behavior and no glow when unlit. Recovery also injects failure while uploading the foam texture, verifies unchanged saved data/redo, and retries. Before/after close and oblique screenshots were inspected. The separate 7,323-plant Tropical Grove coastal run recorded 53–56 FPS with water enabled at 1080p on the RTX 5060; background/clock variability prevents isolating an exact cost from the short before/after runs. See [measurements, reproduction and limitations](benchmarks/water-foam-2026-10-18.json). The full browser suite was not rerun.

The final RTX 5060 coastal measurement of the external 7,323-plant Tropical Grove recorded **31 FPS with scenery reflections** and **39 FPS with sky reflections**, at 1920 × 1080. The dense canopy view recorded **29 FPS with scenery reflections** and approximately **30 FPS with sky reflections**; it has little visible water. The earlier failed integrated-adapter selection is resolved for this test launcher. Runs have substantial clock/background variability, so these observations do not establish an exact speedup or sustained 30 FPS throughout the scene. The coastal view mainly sees the finite terrain boundary; it is a rendering stress view, not a finished beach composition.

For a repeatable forest comparison, start `npm run dev -- --port 5190 --strictPort`, then run:

```sh
node scripts/benchmark-water.mjs "C:/path/to/project.terrain" .qa/water-performance.json
```

The script uses a temporary Chrome profile, adds water in memory, and compares water off, sky reflections, and scenery reflections from one fixed camera at 1080p. On Windows, the shared test helper reads DXGI adapter identifiers with the built-in PowerShell/.NET tools and selects the RTX 5060 when present. Identifiers are read again after each reboot. It changes no Windows graphics or user-browser settings, and the benchmark rejects a different actual adapter before loading the content project. It saves timing data and screenshots without changing the source project. GPU timing, frame intervals and the exact scene are recorded; this bounded comparison does not measure physical input-to-display latency.
