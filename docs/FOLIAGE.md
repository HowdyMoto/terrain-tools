# Foliage authoring

The Foliage inspector opens on **Paint**, with radius, density, spacing, surface rules and Populate together. Use **Models** for brush composition and scale/yaw, **Effects** for leaf lighting, contact and flexibility, **Detail** for LOD/culling, and **Library** for imports, default brushes, portable brush files and asset cleanup. The active brush is always available; the model selector stays visible on pages that edit a model.

## Motion and temporal stabilization

Native `TerrainScene` foliage supplies motion vectors for current/previous wind, contact deformation and instance placement. Existing **Light → View → Stable foliage edges (temporal)** uses them automatically. Authored plant IDs match history after LOD packing, so a plant does not borrow another plant's previous transform. Wind speed, strength, gusts and direction retain their previous drawn values, rather than assuming one fixed simulation timestep. A still pose produces zero leaf motion; moving the camera still reprojects normally.

Opaque cutout leaves reject temporal history when first drawn or returning after culling. Partial LOD cross-fades cap temporal history weight to reduce stale silhouette coverage. Shadow and opaque/water-capture draws share one frame snapshot. The previous-position shader omits the normal/tangent calculation and shadow passes omit previous deformation. Current matrix/contact/fade and previous matrix/contact/validity use two packed instance buffers, staying within default WebGPU limits in the tangent/vertex-color and real fern LOD fixtures.

Camera projection bindings remain stable through temporal pipeline rebuilds. Rendering restores perspective aspect as well as the camera view/projection matrices; jitter must not change the next frame's camera setup. Resize and environment history invalidation reset deformation and camera histories together. Runtime hosts should call `environment.invalidateHistory()` after teleports or discontinuous scene changes. Independent cameras/renderers retain separate CPU histories. Streamed tile admission reserves conservatively for one view; hosts with additional views must budget their history separately.

This is native renderer state, not saved project content. Existing documents, undo/redo and exports keep their formats. Ordinary GLB exports remain static. Explicit WebGL hosts retain their existing temporal implementation; custom host meshes outside `TerrainScene` do not acquire foliage deformation history automatically. Blended transparent foliage retains its opacity semantics and does not receive the opaque-cutout reactive-alpha policy. Motion vectors do not eliminate subpixel aliasing, lighting/shadow animation, screen-space omissions or every temporal artifact.

Validation and the bounded 1080p comparison are documented in [performance evidence](PERFORMANCE.md#foliage-motion-history--19-october-2026). The fixture uses checked-in CC0 Poly Haven fern derivatives by Rico Cilliers (modeling) and Rob Tuytel (scanning); [asset credits](../public/foliage/photoreal/CREDITS.txt) remain included.

## Import plants into a brush

Choose **Foliage → Library → Import foliage assets**. Drop a complete model folder or select **Choose model folder** for extracted glTF packages; this includes the `.gltf`, companion `.bin` and nested textures. Selecting a `.gltf` file alone gives the browser access to that file only. Missing dependencies now show **Locate model folder**, and the importer remembers the failed selection so you can add just the missing files and retry. Folder drops read every directory batch and preserve relative paths. A multi-file chooser can resolve unique dependency basenames; folder imports require the correct relative paths. Missing/ambiguous dependencies name the file to include, and external URLs are never fetched.

Each file's default scene becomes one variant; mesh collections are not automatically split. Select a row to orbit/zoom the model under neutral lighting. The review shows dimensions in metres, triangles, mesh parts, embedded size and source creator credit. Check **Source units** and the ground grid/pivot axes. Grounding centers the model horizontally and puts its lowest point at Y=0; uncheck it to preserve an authored origin. Unit/pivot changes wrap the imported scene without changing source files, mesh attributes, materials or existing copyright metadata.

Choose the destination explicitly:

- **New foliage brush** creates a named brush with equally weighted variants. Ground cover follows slopes and bends; trees stay upright with a stiffer base; rigid objects have no wind/crush. Allowed surfaces are selectable. Starting spacing/density comes from model width, and scale variation starts at 0.85–1.15. Paint a test patch and refine the settings in the inspector.
- **Add variants** keeps existing plants and adds new entries for future strokes, using the destination brush's placement rules.
- **Replace selected model** accepts one file, updates plants using that entry, retains its scale/tint/behavior settings and clears old LOD references. Undo restores the previous model and LODs.

The complete batch applies in one undo step after resource preparation. Cancel/Escape, failed preparation and failed history capture preserve the committed scene, assets and redo branch. A failed Apply can be retried in the same panel. Models are embedded in projects and portable brush presets, including any original credits.

The importer accepts up to 32 variants and 384 MiB of selected input files per batch, with a **320 MiB limit for each prepared embedded GLB**. The dialog shows the remaining project asset allowance; the complete project must stay within 384 MiB of distinct embedded assets and 256 models/256 brushes. Packaging external glTF dependencies can increase the prepared model size. Large imports retain source geometry and textures; read/preparation status stays visible and Cancel preserves the committed project. Save large collections as `.terrain`: portable brush JSON still has a separate 100 MB input limit.

For the common glTF layout with one external geometry buffer, that BIN is stored directly in the prepared GLB binary chunk. This avoids expanding large geometry into base64 text inside JSON. Existing embedded GLBs remain readable; multiple-buffer models retain their embedded-data fallback.

Static glTF 2.0 meshes, Meshopt geometry and KTX2 textures are supported by the editor; convert FBX/OBJ and unpack ZIPs first. Skinned/animated plants and Draco compression are not supported. Heavy-model warnings are advisory; there is no automatic mesh reduction or LOD generation. Add authored LODs through **Distance detail** after importing. The preview shows the rest pose, not animated wind or contact. File size alone does not predict rendering cost or decoded texture memory.

See [workflow verification](benchmarks/asset-import-ux-2026-10-16.json) and [large-model verification](benchmarks/large-model-import-2026-10-19.json) for realistic-asset and browser validation limits. To repeat the optional real-asset check, set `TERRAIN_TEST_GLB` to a local static GLB path and run `npm run test:browser -- tests/browser/large-models.spec.mjs -g "artist GLB"` after building. The source stays outside the repository; generated projects and screenshots go to `test-results/`.

## Compose a brush

Fresh editor projects start with four [photoreal CC0 brushes](FOLIAGE-ASSETS.md): pine, fern, meadow grass, and flowering sorrel. To add them to an existing project, choose **Foliage → Library → Default brushes → Add default brush**. Preparation is cancellable and undoable; it retains existing brushes and plants. Creator credits are linked in the panel and embedded in the model files.

Open **Foliage**, select a brush, and use **Duplicate brush** to start a separate population. Name it, then use **Add model** for each plant, rock, or imported static GLB. A brush supports up to 32 model entries; the same asset may appear in several entries with different settings.

Select an entry in **Model in mixture** to edit:

- **Relative probability:** weights are normalized within the brush. Weights 3 and 1 produce approximately 75% and 25% of accepted placements. Zero disables new placement of that entry. If all weights are zero, no instances are placed.
- **Scale and yaw:** each new instance samples the entry’s scale and rotation ranges uniformly. Yaw is in degrees around the surface normal when alignment is enabled, or around world up otherwise.
- **Align to surface:** follow terrain slope, useful for ground cover. Leave disabled for upright trees.
- **Wind flexibility:** independent per model; the **Wind** tab sets the overall direction, speed, strength, and gusts.
- **Asset contact interaction:** enable **Respond to contact** only for models that should bend or compress. Set **Compression**, **Contact radius** in metres, and **Recovery time** in seconds for the selected model. This entry's settings apply to all its placed instances; other entries and brushes keep their own settings. New photoreal grass/ground-cover brushes and ground-cover imports enable contact; new tree/rigid imports and photoreal pines disable it. Trees can still sway in wind.

Probability, scale, and yaw changes apply to future placements. Existing instances retain their model and sampled transform. Asset, alignment, and response edits update existing instances. **Remove model** also removes that entry’s placed instances; Undo restores both.

## Shape plant response

### Light passing through leaves

In **Foliage → Effects → Leaf lighting**, enable **Thin-leaf translucency** for the selected model. New photoreal default brushes include conservative settings; existing documents keep their appearance until enabled. The effect adds albedo-tinted, shadowed light to backlit leaves in the existing PBR pass. It follows the same bent normals as wind/contact and applies to distance LODs.

- **Leaf cutouts only** matches alpha-tested materials and leaves opaque bark unchanged. **All model materials** also supports leaf geometry without cutout textures. Under **Choose materials**, exclude bark, twigs and other rigid surfaces explicitly, including bark that also uses alpha testing. Names match across LODs. Split a material shared by bark and leaves in the source model when separate treatment is needed.
- **Transmission strength** controls the light passing through. **Leaf thickness / absorption** is a dimensionless optical thickness: greater values absorb more light, especially at grazing incidence. **Transmission tint** multiplies the original leaf color; white is a useful starting point. **Light wrap** softens the angular transition around grazing sunlight.
- **Smooth leaf edges (MSAA)** enables alpha-to-coverage for opaque cutout materials. It needs a multisampled canvas or render target; the editor canvas uses MSAA. The original alpha cutoff still controls the silhouette and shadow passes. Reducing overall opacity creates see-through sorting/depth problems and is not a substitute for leaf transmission.

Edits use the existing prepared foliage transaction, including undo, failure recovery, autosave, native files and portable brush presets. The authored GLB document restores the shader in Terrain Studio and its runtime; ordinary GLB viewers receive standard static PBR materials without this custom transmission effect. Runtime hosts can use the typed `configureFoliageSubsurface` helper on their own standard/physical materials before first rendering.

This is an inexpensive thin-sheet approximation, not full subsurface transport, refraction, or global illumination. It uses uniform optical thickness per selected material group; painted thickness/transmission maps and underside albedo are not implemented. HDRI illumination has no cast visibility, and this added transmission term responds to direct directional/point/spot lights. Keep good albedo, normal, roughness, alpha and baked AO textures. Fine alpha mipmaps, leaf normals and sufficient near-field geometry remain essential. See [lighting quality and forest limits](ENVIRONMENT.md#natural-sunlight-and-forest-quality).

### Bend and contact response

Use **Asset contact interaction** to tune responses to ground contacts, such as bodies dropped in the physics preview. Recovery time is the exponential time constant: after one interval without contact, roughly 37% of the response remains. Contact radius measures from each contact's centre; overlapping contacts use the strongest response. Disabling contact clears the selected model's current compression. Wind and the bend mask remain separate controls.

Existing projects without per-model contact settings retain their original global behavior. Editing a model's contact controls stores its own settings and folds the former global strength into its Compression value. Other models retain their previous behavior. Overrides round-trip through native projects, portable brushes, JSON and the embedded GLB authoring document.

Open **Plant flexibility** for the selected model. **Bend mask** controls which vertices respond to both wind and contact; the existing wind/crush sliders remain independent multipliers.

- **Whole plant** preserves older projects: wind increases with height, and contact tilts/compresses the entire instance.
- **Height ramp** measures 0 at the primary model's lowest point and 1 at its highest. For a stiff trunk and soft crown, start with **Rigid below** 0.55, **Full flexibility above** 1, and **Response curve** 2. Every LOD uses the primary height range and pivot.
- **Vertex color · red/green/blue/alpha** reads the chosen channel. Black/0 is rigid; white/1 is flexible. Vertex colors retain their material tint/opacity role.
- **Imported flexibility mask** reads a dedicated GLB attribute without changing material color. The inspector reports how many mesh parts have the selected channel at each LOD. Missing channels make that part rigid; an RGB color does not implicitly supply alpha.

The two thresholds remap source values into 0–1; keep them at least 0.001 apart. **Response curve** ranges from 1 (linear) to 8 (more rigid through the middle). Changes affect existing plants and support undo, autosave, reusable brushes, native packages, and authored GLB restoration.

For a painted mask, set trunk and attachment vertices to 0 and increase smoothly along soft stems/leaves. Include enough segments for visible curvature; disconnected mesh parts and sharp mask changes can expose seams. Supply matching masks, origins, and dimensions on every LOD. Wind follows the terrain’s authored direction after plant alignment and yaw; masked contact bends around the model's base and compresses flexible vertices while leaving rigid vertices in place. Recovery continues while instances are hidden.

### Export a mask from an asset pipeline

Write an application-specific vertex attribute named `_TERRAIN_FLEXIBILITY`: one finite SCALAR value per POSITION vertex, from 0 to 1. Float32 values or normalized unsigned 8/16-bit values are supported, including interleaved attributes. Follow glTF's vertex alignment/stride rules. Invalid dedicated masks fail during asset preparation, before replacing the current model. Custom semantics and normalized accessor encodings follow the [glTF specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#meshes).

Use the dedicated attribute when the asset's color channels are already occupied. Height ramps need no extra authoring data. Imported node transforms are baked before height normalization, and the source asset remains unchanged.

The lit, directional-shadow, and point-shadow passes use the same deformation. Surface normals and tangents follow the bend; painted-mask gradients are estimated from adjacent triangles. Response is procedural; physical branch mechanics require a host simulation. The ordinary GLB presentation exports masked plants in their rest pose, while its embedded authoring document restores the masks and live behavior.

## Paint and populate

Select allowed surface layers, their combined minimum weight, and a slope limit. No selected surfaces means no placement. Holes and points outside the terrain are excluded. The same rules apply to painting and **Populate allowed surfaces**.

Density controls candidate attempts per square metre. Spacing is the minimum centre-to-centre distance, in metres, between instances belonging to this brush, including different model entries, earlier strokes, and adjacent population tiles. Different brushes may overlap. A spacing change affects future placement; Populate reapplies it across this brush’s complete distribution.

**Clear this brush’s plants** removes only the active brush’s placed instances. It keeps the brush definition, other brushes and their plants, and the next instance ID; Undo restores the cleared plants. The button is disabled when this brush has no instances.

Populate replaces only the active brush’s instances and uses the terrain seed. Identical settings and seed reproduce positions, model choices, scale, and yaw. Dense settings may yield fewer accepted instances because of spacing and surface restrictions. The project-wide limit is 50,000 instances.

## Recover from an unsuccessful edit

Brush settings, mixtures, model removal, population and clearing prepare copied brush/instance records before changing history. Visible changes prepare replacement draw buffers first. Recoverable generation, allocation or history-capture failures keep the previous plants, settings, selection and IDs, preserve redo, and report an error. Retry after resolving the cause; a successful action adds one undo step and updates autosave.

Names and future-placement settings such as probability, scale/yaw ranges, density, spacing and allowed surfaces do not rebuild the existing draw population. Legacy model conversion still copies plant records before assigning model IDs, so a failed edit cannot partially convert the document.

See [recovery verification](benchmarks/foliage-authoring-recovery-2026-10-15.json) for persistent failure injection, native-file equality, unchanged committed autosave, successful retry, and paint/clear/undo checks.

## Reuse brushes

**Save brush** downloads a `.foliage.json` file containing settings, surface IDs, and referenced embedded GLBs. **Load brush** adds a new brush without changing existing populations. Identical model payloads are reused; conflicting asset IDs are renamed. Surface IDs are matched first; missing IDs map by the source layer’s position. Review allowed surfaces after importing into a different project.

Native .terrain packages, legacy project JSON, and scene GLB preserve mixtures, bend masks, and per-instance model IDs. The standalone runtime renders the same composition and response. Old single-model projects remain supported and are converted when their model settings are edited.

## Distance and detail

Each selected model has **Distance & detail** controls. Add up to three LODs, choose a simpler asset or use **Import LOD GLB**, and set increasing start distances. All versions should share the same origin, orientation, and dimensions. Built-in low-detail pine and grass assets provide a starting example; imported assets retain their own materials.

**Retained density** keeps a deterministic subset at each LOD. It must stay the same or decrease with distance. **Cull distance** hides the model beyond a final distance; 0 means unlimited. Distances measure from the camera to each plant's terrain anchor in local metres, including camera height. The default 10% hysteresis switches outward above 110% of a threshold and inward below 90%, preventing rapid switching around that boundary. Initial loading selects immediately at the authored distance.

All referenced meshes load up front. Each LOD reserves instance buffers for its deterministic retained-density subset; primary meshes retain capacity for every authored plant. A 0% level has no instance capacity. Fades can overlap levels without exceeding these reservations. Native packed buffers upload only their active slots when placement/contact/fade data changes; unchanged passes reuse them. This is not asset streaming: hidden primary plants, anchor/contact state and referenced assets remain resident. Keep level and part counts within the target memory budget. Full-density tree LODs retain every tree; reduced reservations apply when an artist has already chosen density thinning, usually for ground cover.

The third and fourth representations (LOD index 2 or 3) with authored start distances of at least 96 m can combine compatible 32 m source batches into 128 m draw cells. This reduces distant submissions without changing geometry, density, authored IDs, dither coverage, wind or shadow materials. Only opaque/cutout materials combine; alpha-blended and refractive materials retain separate object sorting. The renderer retains source batches for authoring/export and allocates combined streams, so CPU storage can increase. Larger cells reduce culling precision; this is not an impostor or a residency system. Set `new TerrainScene(project, { foliageClusters: false })` or the matching world option for a controlled comparison. The world example accepts `?unclustered`.

For submission-heavy scenes, `foliageClusters: { nearby: true }` also combines primary and intermediate representations into 64 m cells. It preserves plant geometry and material settings but can submit more off-screen triangles and retain more instance storage. Measure CPU and GPU frame time in the target scene before enabling it. This runtime option does not change the saved document; existing scenes retain distant-only clustering by default. Preview it at `/world.html?near-clusters`, or pass `--near-clusters` to the world/tropical benchmarks. Draw clusters update only after affected placement, contact, fade or bounds change; settled wind-only frames do not scan retained source buffers. Static exports contain every primary plant and omit the runtime source marker.

**Transition time (s)** adds a timed dithered cross-fade when a plant changes LOD, disappears through density/far culling, or returns. The first LOD added to a previously unconfigured model starts at 0.25 seconds. Zero switches instantly; older files with no duration retain instant switching. The first camera selection after loading is immediate, so a scene does not start by fading every primary plant.

During a fade, levels use complementary screen-pixel coverage with a stable seed per plant. Alpha-tested leaf cutouts remain intact, and directional/point shadows use the same coverage rule. Wind and contact deformation continue on every active level. The fade finishes even if the camera stops; reversing direction samples the current blend before moving toward the new target. Fast camera changes can temporarily keep more than two levels alive.

The fine pixel pattern can be visible on thin leaves, at low resolution, or when LOD silhouettes differ. Inspect transitions at gameplay camera heights, supply matching silhouettes, and tune the duration and distance thresholds. There is no automatic billboard generation. Density thinning is suitable for ground cover; use full density where distant trees must retain a continuous skyline. Longer fades retain overlapping geometry for longer and need an appropriate rendering budget. Settled tiles use the ordinary foliage shader; only tiles with active transitions use the dither variant.

Distance selection changes drawing only. Hidden instances keep their transforms and contact/recovery state; moving closer restores them. Saved projects, portable brushes, and the GLB authoring extension include all LOD settings and referenced assets. The standard GLB presentation always exports complete primary geometry, even if the current camera hides every plant. Plants masked by terrain holes remain excluded from the visible presentation.

The inspector reports unique selected plants, submitted triangles before frustum culling, and the number currently cross-fading. Overlapping LOD representations increase triangle and draw counts without increasing the authored population. The footer's triangle count comes from the renderer. Use `/foliage-benchmark.html` or `npm run benchmark:foliage` after building for a repeatable full-detail/LOD comparison; see [performance evidence](PERFORMANCE.md).

## Core API

```ts
import {
  editFoliageModels,
  populateFoliage,
  serializeFoliageBrush,
  importFoliageBrush,
} from 'terrain-tools';

const brush = project.brushes[0];
const models = editFoliageModels(brush, project.foliage);
models[0].weight = 3;
models[0].interaction = { enabled: false, radius: 4, recovery: 2.5 };
models[0].flexibility = { source: 'height', start: 0.55, end: 1, exponent: 2 };
models[0].lods = [{ model: 'pine-low', distance: 80, density: 1 }];
models[0].cullDistance = 350;
models[0].lodFadeDuration = 0.25;
models.push({
  ...models[0],
  id: 'ground-cover',
  model: 'grass',
  flexibility: { source: 'height', start: 0, end: 1, exponent: 2 },
  lods: [{ model: 'grass-low', distance: 35, density: 0.5 }],
  cullDistance: 120,
  weight: 1,
  minScale: 0.4,
  maxScale: 0.9,
  minRotation: -180,
  maxRotation: 180,
  alignToNormal: true,
  wind: 1.2,
  crush: 1,
  interaction: { enabled: true, radius: 2, recovery: 1.5 },
});
brush.spacing = 1.5;
populateFoliage(project, brush.id);
terrain.rebuildFoliage();
// In the render loop, pass a camera to enable authored distance selection:
terrain.update(deltaSeconds, groundContacts, camera);

const text = serializeFoliageBrush(project, brush.id);
const otherProject = importFoliageBrush(destinationProject, text);
// Load otherProject through TerrainScene.load() to decode its assets.
```

Use unique entry IDs and assign `modelId` on manually created mixed-brush instances. `editFoliageModels` assigns IDs to existing legacy instances before returning mutable entries. When `brush.models` exists, it supersedes legacy brush-level model/variation/response fields. Project validation rejects dangling entry IDs, reversed ranges, unknown assets, and invalid weights.

After changing model contact settings in the SDK, call `terrain.rebuildFoliage()` or load a prepared replacement. A model with `interaction` uses its own enabled/radius/recovery fields and `crush` multiplier, independently of `project.interaction`. Its radius overrides the emitter's `GroundContact.radius`; emitter strength still applies. Models without that record keep the legacy project enabled/strength/recovery and emitter radius. `TerrainScene` resolves these settings automatically; direct `FoliageInteraction.update` users can provide a settings resolver and the maximum enabled override radius for the spatial query.

For a host renderer, the core export `FoliageLodTransitions` maintains level coverage independently of Three.js. Construct it with the instance count, 1–4 visible levels, and duration in seconds. Call `setTarget(index, level, elapsedSeconds)` with `-1` for hidden, then `advance(elapsedSeconds, callback)` each frame. `writeRange(index, level, output, offset)` writes complementary lower/upper coverage bounds into an existing buffer; `reset()` restores full primary coverage. Treat its `weights` and `targets` arrays as read-only views. `TerrainScene` handles these steps automatically.
