# Terrain Studio

A Three.js terrain authoring toolkit and local browser editor for sculpting landscapes, blending surfaces, placing vegetation, and testing terrain collision.

**Status: active development.** The first implementation covers the authoring loop, but this is not yet a production-ready AA terrain pipeline. See [the implementation plan](docs/ROADMAP.md) for remaining work and verification gaps.

The engine audit is tracked as [prioritized GitHub issues](https://github.com/HowdyMoto/terrain-tools/issues). The runtime now streams terrain tiles with shared assets, distance-dependent terrain detail and optional Rapier collision. Open `/world.html` for the 2 × 2 km forest/open-ground/coast example. The editor still authors one terrain at a time. See [world streaming contracts and limits](docs/RUNTIME.md#world-tile-loading-foundation).

**Water:** open **Water**, enable **Show ocean**, and set **Water height (m)** for an ocean at sea level, independent ponds/lakes, adjustable swells, depth-dependent clarity, reflections and detailed shoreline foam. See the [water guide and current limits](docs/WATER.md) and [complete system design](docs/WATER-DESIGN.md).

**Rendering:** the editor, import previews, `/runtime.html`, and `/world.html` use native **WebGPU**. Terrain, vegetation, shadows, atmosphere, water and PBR baking use node shaders. Startup rejects a WebGL fallback and explains recovery if WebGPU is unavailable. Existing project files need no conversion. The first optimization pass raises measured native traversal FPS from 0.147 to 35.72 on the RTX 5060 at 1080p; frame-time spikes still miss steady 30 FPS. See [performance evidence](docs/PERFORMANCE.md) and [WebGPU integration and validation](docs/WEBGPU.md). That isolated measurement predates the final shadow-cleanup correction; its final-code retest was contended by iRacing, so a clean repeat remains pending.

## Run locally

Requires Node.js 22.12+ (Node 24 is used for development), npm, and current Chrome or Edge with native WebGPU and hardware acceleration. Serve over localhost or HTTPS.

```sh
git clone https://github.com/HowdyMoto/terrain-tools.git
cd terrain-tools
npm ci
npm run dev
```

Open the Local URL printed by Vite. The standalone integration example is at `/runtime.html`. If port 5173 is already occupied, Vite selects the next port. Projects stay on your computer; no account or backend is required. The interface uses system font fallbacks if online fonts are unavailable.

Startup shows a loading modal with an animated indicator, completed-stage progress and default-brush download counts. It stays open until the first scene frame finishes. The bar measures loading stages rather than estimated time; startup errors offer Reload and a download of the locally saved project.

```sh
npm run typecheck     # TypeScript checks
npm run lint          # ESLint checks for production TypeScript in src/
npm test              # Core behavior and real Rapier collision tests
npm run build         # Typed library in lib/ and editor/examples in dist/
npm run build:runtime # Build only the reusable package
npm run build:example:upland # Rebuild reference meshes/project from checked-in PNGs
npm run build:assets:foliage # Rebuild the bundled CC0 plant GLBs from local sources
npm run build:assets:runtime # Offline Meshopt/KTX2 sample pack from checked-in source derivatives
npm run benchmark:world # Sustained 1080p traversal/teleports; build first; verifies RTX 5060
npm run benchmark     # CPU geometry/collision/contact benchmarks (build first)
npm run benchmark:erosion # CPU weathering at 128, 256 and 512 cells (build first)
npm run benchmark:surfaces # GPU cost of optional texture variation (build runtime first)
npm run benchmark:foliage # Browser full-detail/LOD comparison (build first)
npm run benchmark:foliage -- --count=50000 --shadows --fade=0.25 # Include cross-fades
npm run benchmark:history # Retained CPU memory and undo/redo timings (build first)
npm run benchmark:edit-preview -- --count=50000 # Stroke preview startup and retained buffers
npm run benchmark:water-preview # CPU cost of immediate/deferred water updates (build first)
npm run benchmark:persistence -- --assets=48 # Save responsiveness with 48 MiB of assets
npm run test:browser  # Browser integration checks against the production build
npm run format        # Format source, tests, and documentation
```

For timing without screenshots, run `npm run benchmark:world -- --no-captures --output=test-results/world-timing.json`. The output directory must already exist (the harness creates `test-results`). Reports include wall-clock submission FPS and frame-time percentiles; close other GPU workloads and run benchmarks sequentially. See [performance evidence and measurement limits](docs/PERFORMANCE.md).

Browser tests currently use installed Google Chrome and serve the production build on port 5175. Run the build first. For other environments, install Playwright Chromium with `npx playwright install --with-deps chromium`. Linux CI installs `mesa-vulkan-drivers`, `vulkan-tools` and `xvfb`, and runs full Chromium with a software Vulkan display and explicit SwiftShader WebGPU adapter. These results are not hardware performance evidence.

The editor requests a high-performance GPU. Hover over the FPS counter or green GPU indicator to see the adapter Chrome selected. On Windows laptops, a browser/OS graphics preference can still override that request. Choose the dedicated GPU for Chrome in Windows **Settings → System → Display → Graphics**, then restart Chrome. Automated Windows browser checks and the water benchmark launch a separate temporary profile. Their shared helper uses built-in PowerShell/.NET to read DXGI adapters and explicitly selects the RTX 5060 when present using Chromium's [adapter-selection switch](https://chromium.googlesource.com/chromium/src/+/main/ui/gl/gl_switches.cc). Other hosts retain the high-performance request. No extra package installation is needed, and neither the user profile nor Windows graphics settings are changed. WebGPU may report only the vendor and architecture for privacy. Performance evidence must record the actual adapter.

Run the navigation checks with `npm run test:browser -- tests/browser/navigation.spec.mjs` after building. If the large unit-test fixtures exceed Vitest’s default five-second limit, use `npm test -- --testTimeout=15000`; see [verification scope](docs/ROADMAP.md#verified-evidence).

ESLint checks `src/` using the recommended JavaScript and TypeScript rules; formatting stays with Prettier. Test/build-script lint coverage is separate remaining work. The pinned lint setup uses `npm install --save-dev --save-exact eslint@10.13.0 @eslint/js@10.0.1 typescript-eslint@8.71.2 globals@17.13.0`; ordinary setup remains `npm ci`. Configuration follows the [typescript-eslint flat-config guide](https://typescript-eslint.io/getting-started/).

Three.js is pinned to 0.186.1, with `@types/three` 0.186.0 and `@webgpu/types` 0.1.64. The upgrade command is `npm install --save-dev --save-exact three@0.186.1 @types/three@0.186.0 @webgpu/types@0.1.64`; normal setup uses the committed lockfile with `npm ci`. The runtime peer requires Three ^0.186.1. This includes the WGSL array-texture gradient fix required by layered terrain.

## Prepared runtime assets

The compressed runtime pipeline uses pinned development tools: `npm install --save-dev --save-exact @gltf-transform/core@4.5.1 @gltf-transform/extensions@4.5.1 @gltf-transform/functions@4.5.1 ktx2-encoder@0.6.0 meshoptimizer@1.1.0 sharp@0.35.5`. Ordinary installation is `npm ci`; `npm run build` uses the checked-in `public/runtime-assets` pack and never runs the encoder. `npm run build:assets:runtime -- .qa/runtime-assets-repeat` builds an independent copy for hash comparison. It needs no native KTX tool or downloaded source archives. Run `npm run test:browser -- tests/browser/prepared-assets.spec.mjs` after building to verify compressed maps, geometry, recovery and editor imports. See [preparation and material palettes](docs/RUNTIME.md#prepared-runtime-assets).

## Editable reference landscape

Open **Sculpt → Terrain → Reference landscape → Open upland meadow**, or preview it at `/runtime.html?sample=upland`. The 96 m scene includes generated ground/grass textures, imported foliage with LODs, limestone props, wind, and contact recovery. Its roughly 20 MiB native package embeds all assets; loading is cancellable and undoable. See [the reference guide](docs/REFERENCE-SCENE.md) for reproduction, provenance, and visual limits.

## Import your own assets

For a downloaded glTF package, use **Choose model folder** or drop its complete folder into the foliage importer. The browser needs the `.gltf`, companion `.bin`, and textures selected together. If files are missing, **Locate model folder** repairs the selection; you can also add missing files without selecting the model again.

Import your own assets through **Foliage → Library → Import foliage assets** or **Surfaces → Maps → Import PBR material**. Both offer multi-file/drop workflows, review before applying, local embedded assets, cancellation and one-step undo. Foliage supports GLB and local glTF dependencies, model previews, unit/pivot correction and explicit new/add/replace destinations. Terrain materials offer Blender, Unreal, Unity Built-in/URP, Unity HDRP and generic OpenGL/DirectX source presets, editable channel conversions, normal conventions and a lit preview. Import extracted PNG, JPEG, WebP, TIFF or TGA texture images; Unity packed smoothness requires PNG/TIFF/TGA alpha. See [foliage import](docs/FOLIAGE.md#import-plants-into-a-brush) and [material import](docs/MATERIALS.md#import-a-complete-texture-set).

Run the import checks with `npm test -- tests/asset-import.test.ts` and, after building, `npm run test:browser -- tests/browser/asset-import.spec.mjs`.

## Downloaded CC0 foliage

New editor projects include **photoreal pine, fern, meadow grass, and flowering sorrel brushes**. Existing projects can add them through **Foliage → Library → Default brushes → Add default brush**. The plants include PBR textures, leaf transparency, grounded pivots, wind settings and distance LODs; saved projects and reusable brushes embed their models. [Prepared GLBs and credits](public/foliage/photoreal/) occupy about 21.6 MB. See [asset preparation and brush settings](docs/FOLIAGE-ASSETS.md).

The optional [CC0 source collection](assets/cc0-foliage/README.md) uses unmodified Poly Haven 2K glTF packages and archives (about 1.99 GB). Those large downloads stay local and are excluded from Git and the web build. Prepared GLBs, original alpha maps, [author credits](assets/cc0-foliage/CREDITS.md), source links, license references, and checksums are included in the repository. A fresh clone can run and build the editor without downloading the source collection.

The offline asset builder uses pinned development dependencies, installed originally with `npm install --save-dev --save-exact meshoptimizer@1.1.0 sharp@0.34.5 @types/node@24.19.2`. Use `npm ci` for subsequent setup; building/running the editor uses the prepared GLBs directly. Rebuilding foliage requires the local source collection and `npm run build:assets:foliage`.

## Editing workflow

**Compact tool settings:** the inspector uses task tabs instead of one long settings list. Sculpt has **Brush / Terrain / Files**; Surfaces has **Surface / Maps / Rules / Paint**; Foliage has **Paint / Models / Effects / Detail / Library**; Props has **Place / Selected / Assets**; Light has **Sun / Sky & fog / Shadows / View**; Water has **Shape / Appearance / Waves / Shore**. Water keeps the selected body, visibility and height above every page. Wind and Project keep short single-page layouts. Sliders and values share a row, advanced settings and tips expand on demand, and tabs, expanded sections and scroll positions are remembered during the session. Arrow keys, Home and End navigate focused settings tabs. Navigation does not change the document or undo history.

**Dynamic daylight:** open **Light → Sun → Time of day → Dynamic sun & sky** to scrub or play a repeating solar day. Latitude, season, north orientation and atmospheric haze drive the sun, moving shadows, sky and PBR illumination together. Pause saves the current time; playback does not create undo steps. Existing static and HDR/EXR setups remain available. See [time-of-day controls and rendering limits](docs/ENVIRONMENT.md#animate-time-of-day).

1. **Sculpt:** raise, lower, smooth, flatten, terrace, noise, or locally erode terrain. Preview seeded hydraulic channels and thermal settling before applying; failed previews or application restore the committed landscape and preserve undo/redo. See [erosion](docs/EROSION.md). Use procedural/imported alpha brushes and rotated add/subtract/set stamps with pen pressure. Save named sculpt presets, including precise custom alphas, to reuse across terrain projects. Import/export PNG16 and RAW16 heightmaps. Cut hole / Fill hole changes surface topology and collision. Generate alpine, dune, island, or flat starting points at 32–512 cells per side while retaining your brushes, assets and settings. Generation and heightmap import prepare replacements before committing; failures retain the previous scene, physics preview and undo/redo. See [sculpting and heightmaps](docs/SCULPTING.md).
2. **Surfaces:** author four PBR layers with tint, roughness, metalness, texture scale, and height blending. Configure altitude and slope intervals with feathering. Paint explicit overrides. Optionally reduce repetition with aligned offset sampling across each layer’s maps. Import albedo, normal, ORM, and height maps. Build ORM maps from separate numeric image channels with gloss inversion and previews, and select OpenGL/DirectX normal conventions. Save/load portable surface presets with embedded maps and optional placement rules. Surface controls, rule edits, map changes and clearing paint retain the previous surface and undo/redo after recoverable preparation failures. See [material authoring](docs/MATERIALS.md).
3. **Foliage:** mix up to 32 procedural or imported static GLB models in each brush. Give each model a probability, scale/yaw ranges, alignment, wind, and crush response. Keep trunks rigid using height, vertex-color, or imported bend masks. Set shared spacing, density, slope, and permitted materials. Paint or populate with a reproducible seed, or clear only the active brush’s plants with Undo. Brush and population edits preserve the previous data and plants after recoverable failures. Author per-model distance LODs, density reduction, far culling, and timed cross-fades. Save/load reusable brush files with embedded assets. See [foliage authoring](docs/FOLIAGE.md).
4. **Props:** place built-in or imported meshes, select their actual surfaces, and use Move/Rotate/Scale handles or numeric controls. Horizontal moves follow the ground; scale stays uniform. Snap uses 0.5 m / 15° / 0.1 steps. Dragging previews the mesh and footprint; release applies terrain/collision as one undoable edit, and Escape cancels. Use circles, rotated rectangles, or **Fit model bounds** for cutouts, including meshes with off-centre origins. Deleting a prop restores its cutout independently of painted holes. Recoverable placement, transform, cutout or removal failures restore the previous scene and preserve selection, instance IDs and undo/redo.
5. **Light, Wind, Water:** separate left-side tabs organize sun/sky or HDR/EXR environment lighting, exposure, fog, shadows and viewport shading; shared wind direction/speed/strength/gusts; and ocean, ponds and lakes. **Water** keeps **Show ocean** and **Water height (m)** at the top of every settings page. Select a pond or lake to change its independent height and visibility in the same place; Shape creates bodies, while Appearance and Waves control clarity/color, reflections and waves. **Water → Shore** also controls wet banks and moving caustic light in the shallows. See [lighting and environments](docs/ENVIRONMENT.md) and [water authoring and limits](docs/WATER.md). Under **Foliage → Effects → Asset contact interaction**, give each selected model its own contact toggle, compression, radius and recovery. New grass responds to contact while new trees stay rigid; wind flexibility remains independent. Failed edits restore the previous settings and redo.
6. **Physics:** enable the lazy-loaded Rapier preview from any tab and click terrain to drop bodies. Flat-terrain contact uses internal-edge correction to avoid unwanted sideways impulses. Toggle placement off or return to an editing tool to stop placing bodies.

Right drag orbits, middle drag pans, and scroll zooms. Left drag paints. `Esc` cancels an active sculpt, hole, surface-paint or foliage stroke. Failed stroke preparation restores the committed scene and keeps redo available; successful release makes one undo step. `F` frames terrain; `[` / `]` change brush radius; `Ctrl/Cmd+Z` undoes; `Ctrl/Cmd+Shift+Z` redoes.

**Spectral ocean:** select **Water → Ocean → Ocean rendering → web-ocean · spectral** for six GPU FFT wave cascades, independent swell, choppy displacement and persistent crest whitecaps. **Waves** offers wind speed, fetch, swell direction, seed and Balanced/High detail. Existing clarity, color, shoreline foam and lighting remain available. Ponds/lakes keep the Standard wave model. Adapted from [web-ocean by Maksymilian Dendura](https://github.com/noniv/web-ocean), MIT; [controls, credits and limits](docs/WATER.md#choose-an-ocean-renderer).

**First-person walkthrough:** press `V` or the footprints button to choose a starting position. Point anywhere on the terrain: a person-sized marker and **Walk here** label show the exact location, standing height, and facing direction. Click or press `Enter` to capture the mouse and start there, including on steep slopes. Entry has no slope, water or scenery clearance restrictions. Right drag to orbit and choose a facing direction; pan and zoom also remain available. `V` or `Esc` cancels placement.

Once walking, use `WASD` to move, the mouse to look, and hold `Shift` to run. `V` or `Esc` releases the mouse and restores the editor view you composed before entering. Losing focus also exits safely. **Project → First person → Eye height** sets the camera height above terrain (default **1.8 m**, range 0.1–100 m). This setting is saved with the project and used by the preview and movement; older projects also default to 1.8 m. Walking uses 6 m/s walking and 12 m/s running, follows the rendered terrain triangles, and stops at terrain edges and holes (including prop cutouts). There is no jumping, gravity, walking slope limit, or continuous collision with props, foliage or water. Editing is disabled during placement and capture; navigation does not change your project or undo history. Hotkeys are ignored while typing or using a dialog.

First-person mode renders the latest mouse pose with at most one unfinished GPU frame. It yields to input while the GPU is busy and limits the drawing buffer to a 1920 × 1080 pixel budget, preserving the viewport's aspect ratio. This prevents high-DPI/fullscreen views from silently quadrupling the rendering cost. Lighting, shadows and foliage settings remain active; exiting restores the editor's device resolution. The FPS counter uses elapsed wall time, including stalls. See [measured input delay and limits](docs/benchmarks/walk-latency-2026-10-17.json) and [the rendering follow-up](docs/benchmarks/forest-performance-2026-10-17.json).

To reproduce the mouse/GPU measurement with an external content project, start `npm run dev -- --port 5174 --strictPort`, then run `node scripts/benchmark-walk.mjs "C:/path/to/project.terrain" .qa/walk-latency.json` in another terminal. It uses a temporary Chrome profile, fullscreen first-person mode at 1920 × 1080 CSS pixels, device scale factors 1 and 2, and records the actual GPU. Instrumentation is injected into the development page only. Timing ends when a GPU fence is observed complete; it does not measure physical mouse-to-monitor latency.

**Terrain size:** one world unit is one metre. Resolution counts cells, independently of physical dimensions: **512 × 512 cells over 512 × 512 m = 1 m per cell**; the same grid over the default 192 × 192 m is 0.375 m per cell. Set width/depth alongside resolution in **Sculpt → Terrain → Generate terrain**; the readout previews both dimensions and cell spacing. The scene panel also pairs resolution with physical size. To resize authored terrain, use **Project → Terrain size → Resize existing terrain** (8–10000 m per side). Sculpting, paint, holes and resolution are preserved. Elevation and water level scale by default; turn off **Scale elevation with size** to keep their heights. Plants and props retain their dimensions and relative horizontal positions, while surface rules and texture repeats stay in metres. Resize preparation can be cancelled, failures preserve the scene/history, and Undo restores the previous size.

**Fullscreen view:** press `Shift+F` or the expand button above the viewport to toggle fullscreen rendering of the 3D view. It works with orbit or first person; the editor panels stay outside fullscreen. `Esc` can also release fullscreen through the browser. If the browser releases mouse capture during a fullscreen change, press `V` and choose a starting spot again. Mouse capture and fullscreen require browser support; failures show a message and leave editing available.

For outdoor lighting, start with **Light → Sun → Lighting preset → Natural sunlight · fine shadows**, then tune solar time and exposure. It enables three camera-following shadow cascades, indirect contact shading and temporal foliage stabilization. **Light → View → Foliage detail recovery** adjusts contrast after temporal smoothing (0–1, default 0.25). The WebGPU scene pass supplies depth, normals, indirect light and velocity to the compositor. **Foliage → Effects → Leaf lighting** adds shadowed translucency to selected leaf materials, with absorption/tint controls and smooth cutout edges. Dense scenes can use 2048 px per cascade and a shorter shadow reach. See [forest lighting guidance and current limits](docs/ENVIRONMENT.md#natural-sunlight-and-forest-quality).

After building, run the rendering/recovery checks with `npm run test:browser -- tests/browser/cascaded-sun.spec.mjs tests/browser/ambient-occlusion.spec.mjs tests/browser/depth-prepass.spec.mjs tests/browser/temporal-aa.spec.mjs tests/browser/forest-lighting-recovery.spec.mjs tests/browser/foliage-shading.spec.mjs`. The external Pine Forest and Namaqualand studies keep their artwork and project-specific builders outside the codebase; see [content projects](docs/CONTENT-PROJECTS.md).

To profile one of those external scenes, run `npm run build:runtime`, then `node scripts/benchmark-forest.mjs "C:/path/to/content-project/exports/scene.terrain" .qa/forest-render.json`. The script uses the `original` or `trail` viewpoint in the parent content project's `content-manifest.json`, launches its own local server and Chrome profile, requires the RTX 5060, and records 1080p GPU pass timings after warm-up. An optional third argument selects a preserved runtime build inside this workspace for comparison. See [measurement scope](docs/PERFORMANCE.md#forest-rendering-on-the-rtx-5060). The separate walk benchmark above measures actual editor input delivery and GPU completion.

## Save and exchange

Keep individual landscapes in separate folders outside this repository. A `.terrain` file embeds the art it needs; source downloads, converted assets, credits and project-specific scripts belong alongside that document. In **Open**, select the `.terrain` file; `content-manifest.json` is descriptive metadata for the folder. See [content project organization](docs/CONTENT-PROJECTS.md) for the folder layout, editor workflow and external build scripts.

Changes autosave to IndexedDB in the current browser. **Save project** downloads a lossless `.terrain` package containing all terrain buffers, material settings, foliage/prop instances, and embedded imported assets. Buffers are binary and duplicate asset payloads are shared. Autosave and native file preparation run on a worker; pending autosaves coalesce while a downloaded file retains its click-time state. Keep editing during preparation. Existing JSON projects and autosaves remain readable. **Open** restores that document. Project, model, brush, and surface imports prepare their resources before changing the scene; use **Cancel** in the progress bar to keep the current document. Undo/redo also waits for required assets before moving history. History shares unchanged data and keeps up to 64 steps within an estimated 256 MiB CPU budget. Older steps expire first; a single oversized step is kept. Hover over Undo or Redo for step counts and memory usage. This budget excludes the live scene, restore preparation, and GPU resources.

**Export scene** creates a GLB containing terrain, instanced foliage, props, and water. Its `TERRAIN_tools_project` extension embeds the complete editable project. Open this GLB in Terrain Studio or pass it to `loadTerrain()` to recover the exact material rules/maps, foliage, wind, and interaction settings. Choose **Fast colors** for the small vertex-color presentation, or **PBR** to bake standard base-color, ORM, and normal atlases for ordinary GLB viewers. Both are static presentations; exact layered behavior and wind remain in the toolkit runtime. See [scene export](docs/EXPORT.md) for resolution, memory, and cancellation details. The SDK retains JSON interchange for smaller documents. See [project files and recovery](docs/PROJECT-FILES.md) for migration, limits, and the binary format.

The viewport screenshot button downloads a PNG. Asset inputs accept static GLB (up to **320 MiB per model**, preserving source geometry and textures), PNG/JPEG/WebP/TIFF/TGA texture maps (up to 16 megapixels per image and 256 MiB per source file, see [format limits](docs/MATERIALS.md#tiff-and-tga-texture-formats)), and **Radiance HDR / OpenEXR environment panoramas** (2:1, up to 4096 × 2048 and 32 MB; see [supported EXR formats](docs/ENVIRONMENT.md#import-hdr-or-exr-illumination)). Texture arrays are configurable at 256², 512², 1024², or 2048². The project allows 384 MiB of distinct embedded assets; Props and Foliage show usage and offer undoable cleanup of unused models. Save large models in native `.terrain` projects; [portable brush/legacy JSON limits and memory considerations](docs/PROJECT-FILES.md#limits) remain separate. Procedural vegetation remains available as lightweight fallback art and in the synchronous core `createProject()` API.

## Architecture

- `src/core/`: engine-independent terrain model, sculpting, rule evaluation, foliage distribution, history, and serialization.
- `src/runtime/`: reusable `TerrainScene`, spatial foliage batches, wind/shadows, interaction, and GLB export.
- `src/render/`: PBR texture arrays, model library, and editor viewport.
- `src/physics/rapier.ts`: optional Rapier integration; only loaded when preview is enabled.
- `src/editor/` and `src/main.ts`: persistence and authoring interface.
- `tests/`: deterministic core tests, actual physics simulations, and browser integration tests.

The package exports `terrain-tools` (pure core), `terrain-tools/three` (rendering/runtime), and `terrain-tools/rapier` (optional physics). Three.js r180 is a shared peer; Rapier is an optional dependency and only loaded on request. See [runtime integration](docs/RUNTIME.md) and [architecture](docs/ARCHITECTURE.md).

## Connect another physics engine

The core contact field accepts ground-contact influences without importing Rapier or Three.js:

```ts
import { FoliageInteraction } from 'terrain-tools';

const response = new FoliageInteraction();
response.setInstances(project.foliage);
const changed = response.update(
  deltaSeconds,
  [{ x: contact.x, z: contact.z, radius: 4, strength: 1 }],
  project.interaction,
);

for (const id of changed) {
  const compression = response.amount(id);
  // Apply compression to your foliage transforms or instance attributes.
}
```

Feed only ground contacts, call with an empty contact array during recovery, and rebuild the spatial index after changing instances. The editor's optional Rapier adapter demonstrates contact detection from actual terrain manifolds.

## License and credits

Terrain Studio's original code, documentation and reference example are available under the [MIT License](LICENSE), copyright 2026 Wright Bagwell. Third-party dependencies retain their own licenses.

The bundled Poly Haven foliage and alpha maps retain their [CC0 1.0 license](assets/cc0-foliage/LICENSE.md). Credit goes to **Rico Cilliers**, **Rob Tuytel**, and **Poly Haven**; see the [per-asset credits and modification notes](public/foliage/photoreal/CREDITS.txt). User-imported artwork retains its own licensing. Personal landscape projects and local research downloads are not part of this repository.
