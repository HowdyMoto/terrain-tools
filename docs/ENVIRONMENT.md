# Lighting and environments

The Light inspector separates **Sun** (time of day, sun and exposure), **Sky & fog** (environment images, background and distance fog), **Shadows** (sun shadows and contact shading) and **View** (temporal stabilization and viewport shading). Advanced sections retain their expanded state during edits and tool changes.

## Author a look

Open **Light** in the left rail. New projects start with a procedural daylight sky. Daylight, Golden hour, Overcast, and Neutral studio presets set a coherent starting point for sun, sky illumination, fog, and display response. Projects saved before lighting settings existed retain the original ambient/sun rig.

The former World panel is split into **Light**, **Wind**, and **Water**. Light also contains flat shading and wireframe controls. Wind sets the shared breeze; Water controls the water plane and its elevation. Contact behavior belongs to each selected model under **Foliage → Effects → Asset contact interaction**, independently of wind flexibility.

- **Sun azimuth/elevation** controls the direction of light and cast shadows. Azimuth 0 points toward +Z; 90 points toward +X. Elevation is degrees above the horizon.
- **Sun intensity/color** and **Ambient fill** control direct and hemispherical light. For HDRI-only illumination, set both to zero; HDRI illumination itself does not produce directional cast shadows.
- **Sky / HDRI intensity** scales environment illumination. **Sky background brightness** controls the visible sky/HDRI independently, so reducing ambient illumination need not darken the sky. Older files without a separate background value retain the linked behavior until this control is edited. Procedural sky, horizon, and ground colors generate a linear-radiance equirectangular texture.
- **HDRI rotation** rotates image-based lighting and its background together. Align the directional sun separately with the bright source in a photographic HDRI.
- **Exposure** is a linear multiplier, not photographic EV. ACES filmic, Neutral and AgX display transforms are available. They affect display, not stored terrain colors or texture samples.
- **Fog start/end** uses distance in metres. The end must exceed the start. Fog color is independent of the sky so it can be matched to the horizon.
- **Sun shadows** has 1024, 2048, and 4096 map options, per cascade. Choose **Camera detail · three cascades** for walking through a forest, or **Whole terrain · one map** for legacy coverage. Shadow distance is in metres; shorter coverage concentrates detail near the camera. Depth/normal bias reduces self-shadow artifacts at the cost of contact precision. Height padding extends coverage for tall assets.

Hide the sky/HDRI background to use a solid color while retaining its illumination. Background blur affects the displayed sky only. Inspect rough and smooth materials together when choosing lighting; reflected environment detail changes with roughness.

## Natural sunlight and forest quality

Choose **Light → Sun → Lighting preset → Natural sunlight · fine shadows** for an outdoor starting point: an aligned atmospheric sky/sun paused at 15:00 solar time, AgX, low hemispherical fill, filtered sky illumination, three 2048 px shadow cascades, contact occlusion and temporal stabilization. Change latitude, season, solar time and exposure to suit the scene. Any imported HDR/EXR stays embedded for later use. The preset is an artistic starting point, not a calibrated photographic exposure or a production-quality guarantee.

Use **Foliage → Effects → Leaf lighting** for [thin-leaf translucency](FOLIAGE.md#light-passing-through-leaves). Tune from a ground-level view with sunlight behind the plants; then inspect the same leaves in shadow and front light. Retain standard rough PBR bark. Keep diffuse albedo free of baked directional lighting and preserve normal, roughness, cutout and AO maps. Low texture resolution, aggressive mesh simplification and incorrect normals can dominate the result regardless of lighting.

The three camera-following shadow maps use overlapping depth slices, texel-stable fitting and blended transitions. Direct sun energy is conserved across the overlap; the final cascade fades to unshadowed light over the last 10% of the reach. Wind, cutouts and leaf transmission use the same sun shadows. Fine shadows cost memory and repeated geometry draws: try **2048 per cascade and 80–160 m reach** for a dense forest before choosing 4096. Lower bias retains contact detail but can reveal self-shadow acne. An HDRI is distant illumination/background; match its sun manually or use the aligned atmospheric sky.

**Light → Shadows → Contact shading** darkens captured indirect diffuse/specular illumination around roots, rocks and overlapping plants. Direct sun and leaf transmission retain their brightness. The native WebGPU pipeline uses Three's GTAO with full-resolution scene depth and packed view normals. Radius is in metres; use modest strength. It cannot see off-screen canopy or supply bounced light. Terrain and imported model textures request up to 8× anisotropic filtering, clamped by the hardware.

**Stable foliage edges (temporal)** accumulates linear HDR frames before the display transform, using Three's TRAA with depth and velocity attachments. It resets on authored lighting changes and resize. **Foliage detail recovery** applies RCAS sharpening after temporal accumulation; 0 disables sharpening, 0.25 is the default, and 1 is strongest. Water uses reduced temporal history weight. Native vegetation supplies previous wind/contact deformation and ID-matched instance motion, with reduced history for fresh and fading cutouts. Fast thin leaves can still soften or trail; see [motion and temporal limits](FOLIAGE.md#motion-and-temporal-stabilization). Cascaded shadows and screen effects add rendering cost. The explicit WebGL runtime retains its earlier depth/AO and temporal implementation; [previous RTX 5060 measurements](benchmarks/forest-performance-2026-10-17.json) describe that backend, not WebGPU.

**Light → Shadows → Canopy shade & bounce** adds optional off-screen tree cover and local ground-tinted indirect bounce. It prepares a terrain-following 24 × 8 × 24 RGBA16F field and a 24 × 24 R16F ground-height map (38,016 bytes total, without mipmaps). The field covers up to 64 m above the terrain and uses 12 sky rays over a 48 m radius with ellipsoid crown bounds for plants at least 2.5 m tall. Strength changes indirect diffuse and a restrained portion of indirect specular; direct sunlight, shadow maps and leaf transmission retain their PBR paths. Bounce follows actual sun intensity, color and elevation, and becomes zero with no sun. Zero shade strength can still use bounce.

This is a bounded approximation, not triangle GI. It does not trace leaf alpha, props, terrain visibility between probes, multiple light bounces or moving wind silhouettes. Ground tint comes from linear material colors (the ground-bounce color substitutes for white texture tints), not a sampled albedo atlas. Broad crowns and dense overlapping tree bounds can over-darken a canopy; start near 0.65 strength / 0.35 bounce and inspect the result. Each terrain has its own field, so adjacent independently baked world tiles can disagree at their boundary. Crown proxies stay upright even for slope-aligned plants. The field follows rigid terrain transforms; independently moving trees need a new bake. Runtime hosts can inspect `terrain.canopyLighting.error` if an automatic rebake fails.

Enabled fields prepare on a disposable worker before adoption. CPU/GPU preparation failure keeps the current document, field and history; runtime edit rebakes debounce settled edits and retain the old field while a preview is active. Project files store settings, not baked textures. Loading rebuilds the field. Native WebGPU is required for this optional feature. Runtime hosts may call `terrain.canopyLighting.prepareGPU(prepared.value.canopy, renderer)` on a staged `TerrainScene.prepareLoad()` result before applying it, as the editor does.

CryEngine parity is **not established**. Full spatial GI, volumetric fog/cloud shadows, coverage-preserving foliage mipmaps and production tree impostors remain open. Native plant motion vectors and approximate off-screen canopy cover are implemented. Bounded terrain streaming is available in the world example. The default pine is an approximate twig-card derivative, and the 50,000-instance admission limit is not a performance promise. Inspect and profile real assets at the intended resolution and on the actual dedicated GPU. The local Pine Forest study and [measured evidence](benchmarks/forest-lighting-2026-10-17.json) use a desktop 1080p/30 FPS target on an RTX 5060 Laptop GPU; the earlier Radeon 860M measurements are not that target.

The distinction between cutout opacity and leaf transmittance follows the [CryEngine vegetation shader documentation](https://www.cryengine.com/docs/static/engines/cryengine-3/categories/1114113/pages/1048607). [Three.js alpha-to-coverage](https://threejs.org/docs/pages/Material.html#alphaToCoverage) requires MSAA. Native cascades and contact shading use TSL nodes and explicit scene attachments. The WebGL compatibility path uses local material hooks.

## Animate time of day

In **Light → Sun → Time of day**, enable **Dynamic sun & sky**. This selects an atmospheric procedural sky while retaining any imported HDR/EXR image for later use. Existing projects stay static until this option is enabled.

- Set **Solar time** precisely, use the time slider, or select 06:00, Noon, 18:00 or Night. Time edits pause playback so you can assess the look. Solar noon is 12:00; these are solar hours, not civil clock/time-zone values.
- **Play day / night cycle** advances a repeating 24-hour day. **Full day lasts** sets its duration in real minutes (0.25–1440). **Pause at current time** saves the displayed instant as an undoable edit. Playback itself changes neither the project nor history/autosave; a project saved while playing restarts at its authored starting time. Undo/reload also restores the authored starting point.
- In **Sun path & atmosphere**, set latitude, season/day of year and north rotation. North starts at +Z and east at +X. Latitude accepts both poles, including polar day and polar night. Season stays fixed as the clock loops.
- Adjust haze and blue-sky scattering to shape the horizon and sky. Sun intensity/color, exposure, ground bounce, sky intensity and shadow settings remain available below. **Match fog to sky** follows daylight/twilight/night colors using the existing fog distances; disable it for an authored fog color.
- **Night sky brightness** supplies adjustable sky fill. There is no moon light or star field. Pause holds dynamic lighting; switching Dynamic sun & sky off restores the manual lighting controls. Choosing a fixed lighting preset or HDR/EXR illumination also exits the cycle.

The sun path uses the [NOAA solar-declination approximation](https://gml.noaa.gov/grad/solcalc/solareqns.PDF), evaluated for the selected season. The sky uses the installed Three.js r186 [analytic atmospheric scattering model](https://threejs.org/docs/pages/Sky.html), with an artist-controlled night transition and ground bounce. The directional sun warms and fades near the horizon and stops lighting terrain below it. The sky's solar disc follows the same direction; the disc is excluded from the illumination probe to avoid adding a second unshadowed direct sun.

The visible sky, sun and shadows update continuously. Roughness-filtered sky reflections/indirect light refresh at most twice a second through a 128-pixel cube probe and two reusable PMREM outputs; the previous complete output remains active if a refresh fails. Shadow bounds are cached between terrain edits. This is a bounded real-time lighting approach, not path tracing or calibrated irradiance: it does not include volumetric clouds/fog, multiple atmospheric scattering, cloud shadows, lunar phases, or civil-time/longitude/refraction corrections. Very fast cycles can reveal the half-second reflection cadence. Shadow detail still depends on terrain extent, map resolution and bias.

Edits prepare sky resources before history changes. Failed capture or history preparation leaves the committed scene, saved data and redo available. Saved projects, native packages and embedded GLB authoring data retain cycle settings; the toolkit runtime restores the same atmosphere. Generic GLB viewers still show the static presentation, not this lighting controller.

## Import HDR or EXR illumination

**Import HDR / EXR environment** accepts a 2:1 equirectangular panorama, 64 × 32 through 4096 × 2048 pixels, up to 32 MB. The format is detected from file contents. Both formats work in the editor and `TerrainEnvironment` runtime API.

- Radiance RGBE `.hdr`: `-Y / +X` orientation, flat pixels or modern scanline RLE. Legacy pixel-run encoding is unsupported.
- OpenEXR `.exr`: single-part scanline RGB or RGBA, matching HALF or FLOAT channels, increasing Y line order, square pixels, full matching data/display windows, without subsampling. NONE, RLE, ZIPS, ZIP, PIZ, PXR24, DWAA and DWAB compression are accepted by the bundled Three.js r186 decoder. B44/B44A, tiled, multipart, deep, layered/extra-pass, cropped and cube-map EXRs are rejected with an import error. DWAA/B block versions remain subject to the r186 decoder's support.

Use **linear sRGB / Rec.709** color primaries. Files without chromaticities metadata are assumed to use these primaries; other declared primaries, including ACEScg, must be converted before import. Display tone mapping is separate. EXR optional metadata is inspected, then unnecessary attributes are omitted before decoding. Scanline offsets are validated and normalized to handle physically reordered chunks correctly. See the [OpenEXR file layout](https://openexr.com/en/latest/OpenEXRFileLayout.html) and [Three.js EXRLoader](https://threejs.org/docs/pages/EXRLoader.html); this importer deliberately accepts a narrower subset than the general format.

Dimensions and scanline structure are validated before image allocation; compressed samples are decoded and checked before application. Radiance is retained in a half-float linear texture, including values above display white. EXR FLOAT values outside the finite half-float range are clamped to ±65504; NaN and infinity are rejected before conversion. Original file bytes remain embedded unchanged. The [Three.js environment pipeline](https://threejs.org/docs/pages/PMREMGenerator.html) prefilters the texture for roughness-dependent PBR illumination. Replacement disposes the previous source and its renderer-managed environment maps.

A failed import leaves the current environment and project intact. Failed preset, parameter or sky preparation/history capture restores the controls to the committed values and retains undo/redo. Unused prepared environment textures are released. HDR and EXR images are embedded in JSON, native `.terrain` files, autosave, and the scene GLB's authoring extension. Removing an image is undoable. Preset changes retain the embedded image so you can select it again; **Remove environment image** removes it from the current document.

Automated fixtures cover Radiance HDR and EXR HALF/FLOAT with NONE/ZIPS/ZIP compression, radiance above white, image orientation, offset-table ordering, invalid headers, truncated blocks and non-finite samples. Browser scenarios cover successful imports, failed replacements, undo/redo, autosave, native files, GLB restoration and the runtime. A real 1024 × 512 FLOAT/PIZ panorama, [Autumn Field PureSky](https://polyhaven.com/a/autumn_field_puresky), also decodes and renders successfully in Chrome 155 on AMD Radeon 860M / Direct3D11, without renderer or shader errors. Credits: Sergej Majboroda (original), Jarod Guest (sky edits), Poly Haven, CC0. This QA download and its verification record are retained in `.qa/`, not bundled as a default environment. Other compression variants and browsers still need representative-asset validation.

## Use the same lighting in a Three.js application

The core and `TerrainScene` remain independent of the host's lighting. Opt into the same look with the public environment component:

```ts
import { loadTerrain, TerrainEnvironment } from 'terrain-tools/three';

const terrain = await loadTerrain(projectJsonOrGLB);
scene.add(terrain);
renderer.shadowMap.enabled = true;
const lighting = new TerrainEnvironment(scene, renderer);
await lighting.load(terrain.project.environment, terrain.project);

// Each frame, after updating the camera:
terrain.update(deltaSeconds, [], camera);
lighting.tick(deltaSeconds);
lighting.render(camera); // Includes authored cascades, AO and temporal resolve.

// After editing heights:
lighting.fitShadow(terrain.project);

// Parameter changes using the already-prepared image:
lighting.set(terrain.project.environment, terrain.project);

// When this world is unloaded:
lighting.dispose();
terrain.dispose();
```

`TerrainEnvironment` owns its lights and scene environment/background/fog settings, plus renderer exposure and tone mapping when a renderer is supplied. Dispose restores the scene's previous display settings, material hooks and owned resources. Use one environment controller per scene, and clone materials before sharing them between independently lit scenes. Shadow fitting assumes the untransformed terrain is centred at the origin; applications that transform terrain can supply their own light rig.

`render(camera)` accepts an initialized native WebGPURenderer from `createTerrainRenderer()` or an explicit WebGLRenderer and a perspective or orthographic camera. It supports an opaque full-viewport scene, including a full-size render target; XR, partial viewports and transparent-canvas compositing are not supported by the temporal pass. Call this instead of `renderer.render(scene, camera)` to apply the authored screen effects. Hosts with their own compositor can call `updateCamera(camera)` for cascaded shadows alone, then render themselves. Hosts that do neither retain the original terrain-wide sun. Render/camera state is restored after screen passes. Custom GLSL ShaderMaterial surfaces need TSL equivalents on WebGPU; built-in lit materials receive the effects automatically.

Contact depth is reusable on ordinary 2D targets with a depth texture and automatic depth clearing. Transparent, wireframe, stencil-writing and unusual depth-test materials stay out of the prepass. Custom vertex deformation must provide a matching `customDepthMaterial`; the toolkit's foliage already does this for wind, contact and LOD fades. Material effect uniforms remain connected when replacing an environment, even if Three.js reuses a cached shader program.

For atomic world replacement, call `await lighting.prepare(settings)`, finish other asset preparation, then `lighting.apply(prepared, project)`. The standalone equivalent is `prepareEnvironment(settings, renderer)`; pass the real WebGL renderer to prepare dynamic sky illumination. Apply takes ownership. Dispose a candidate if it is rejected or superseded. `load` applies only the latest request and keeps previous lighting on decode failure. Without a renderer the dynamic component still supplies its sky mesh and sun/ambient rig, but cannot capture filtered sky reflections.

Use `defaultTimeOfDay()` from `terrain-tools` to create a complete cycle record, set `enabled: true`, and set the environment mode to `sky`. `lighting.solarHour` and `lighting.cycleState` expose the current simulated time and sun position without mutating the project. `lighting.animationError` reports a recoverable reflection-refresh or screen-pass failure; failed screen effects fall back for that frame and retry. `tick()` accepts elapsed seconds; the editor caps frame deltas to avoid large jumps after backgrounding the tab.

The editor and `/runtime.html` use this shared implementation. Ordinary GLB viewers do not apply the embedded environment; load through the toolkit to restore the authored look. Lighting controls alone do not establish photorealistic asset quality or a calibrated daylight simulation.
