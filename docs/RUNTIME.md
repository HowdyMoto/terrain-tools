# Runtime integration

Build with `npm run build:runtime`. To use the toolkit from another local project, run `npm pack` in this repository and install the generated tarball there. The package is private and this command does not publish it. It includes JavaScript, TypeScript declarations, and documentation. Reference-scene art and native packages belong to the editor build in `dist/examples/`; the reusable library build does not copy `public/` assets.

Three.js ^0.186.1 is a peer dependency so the host and toolkit use the same Three instance. Rapier is optional: consumers can omit optional dependencies when using another physics engine. Importing the core or Three entry does not initialize or load the physics engine.

For strict TypeScript checks of the Three.js entry point with `skipLibCheck: false`, include `"@webgpu/types"` in your compiler's `types` array alongside any other required global types. The installed r186 Three.js declarations reference `GPUTexture`; those WebGPU declarations are required even when the application renders with WebGL. The package compatibility check uses `module` and `moduleResolution` set to `NodeNext`, `target: "ES2022"`, and the `ES2022`/`DOM` libraries.

## Load an authored scene

```ts
import { createTerrainRenderer, loadTerrain } from 'terrain-tools/three';

const renderer = await createTerrainRenderer(); // Native WebGPU; rejects unavailable devices
renderer.setSize(innerWidth, innerHeight);
document.body.append(renderer.domElement);

const response = await fetch('/assets/my-world.glb');
if (!response.ok) throw new Error('Terrain request failed');
const terrain = await loadTerrain(await response.arrayBuffer());
scene.add(terrain);

function frame(deltaSeconds: number) {
  terrain.update(deltaSeconds, groundContacts, camera);
  renderer.render(scene, camera);
}

// When this world is unloaded:
scene.remove(terrain);
terrain.dispose();
```

Pass a `.terrain` package ArrayBuffer or legacy JSON text to load a saved project directly; ArrayBuffer inputs are detected by signature. Browser hosts can pass a File or Blob directly for bounded reads. `loadTerrain` validates and decodes assets before returning. The host owns the initialized renderer, camera, render loop, and game objects. `createTerrainRenderer()` initializes native WebGPU and installs the terrain lighting contract. Dispose it after the scene resources. Host-created `WebGPURenderer` instances must be initialized before KTX2 decoding; `TerrainEnvironment` installs the lighting contract on these too. The reusable library retains explicit WebGLRenderer compatibility for existing hosts, while shipped interactive entry points require WebGPU. See [backend integration](WEBGPU.md). It can provide its own lighting or restore authored lighting with `TerrainEnvironment`; see [lighting integration](ENVIRONMENT.md). Set renderer shadows to use the runtime's wind-deformed foliage shadows. The standalone `/runtime.html` example uses these package exports, not the editor's UI classes.

With authored environment rendering, call `lighting.tick(deltaSeconds)` and `lighting.render(camera)` after `terrain.update()`, replacing the direct renderer call above. This applies optional camera-following sun cascades, contact occlusion and temporal stabilization. `lighting.updateCamera(camera)` provides cascades alone for hosts supplying their own screen compositor. Request `powerPreference: 'high-performance'` when constructing a desktop renderer, and record the actual selected GPU when profiling; browsers may override the preference. See the environment guide for full-viewport and material ownership constraints.

All authored positions use local metres, XZ ground, and Y up. `terrain.update(dt, contacts)` expects local ground-contact X/Z coordinates. Each contact has `{ x, z, radius, strength }`. Supply an empty array when contacts stop; compressed foliage recovers over time. Convert world contacts to terrain-local coordinates if the host transforms the group. Authoring exports use terrain-local coordinates; host scene placement is separate game state.

`project.size` is the square side length in metres; `project.resolution` counts cells per side. For example, `createProject(512, 512)` creates 512 × 512 cells over 512 × 512 metres. `resizeTerrain(project, size, scaleElevation = true)` returns a candidate without changing the source: grid resolution, paint and holes remain; terrain elevation and water level scale unless disabled. Prop/plant XZ positions scale, while their dimensions, surface rules and texture repeats remain in metres. Unchanged buffers and metadata are shared, so stage the candidate with `terrain.prepareLoad` and commit it before further editing. `project.view.eyeHeight` stores the editor's first-person camera height in metres; `parseEyeHeight` validates 0.1–100 m and supplies `DEFAULT_EYE_HEIGHT` (1.8 m) for older projects. These values persist in JSON, native packages and editable GLBs; host applications provide their own character controller.

Passing a camera as the third argument enables authored foliage LOD, density thinning, and far culling. Camera positions are converted to terrain-local space, including parent transforms. Omitting the camera leaves the current selection unchanged; a newly loaded scene starts at full primary detail. Use `terrain.foliage.updateView(camera)` separately when needed, or `terrain.foliage.resetView()` for a full-detail comparison. `terrain.foliage.viewStats` reports selected instances, culled instances, selected batch meshes, triangle count, and counts per LOD before frustum culling. With a positive per-model `lodFadeDuration`, `transitioning` counts plants in a timed fade and `drawnInstances` counts their submitted representations across all LODs. The sum of `levels` can exceed the unique `instances` during overlap. Keep calling `terrain.update(dt, contacts)` to advance existing fades, even when the camera is stationary or selection is handled separately with `updateView(camera)`. Time uses the supplied delta in seconds. Initial selection and `resetView()` are immediate. Call `rebuildFoliage()` after changing LOD or flexibility-mask settings. Per-model `flexibility` selects height, a vertex-color channel, or an imported scalar mask; see [plant flexibility](FOLIAGE.md#shape-plant-response). Masked instances retain their anchor transform; sparse contact updates write a scalar per drawn instance. Each batch shares prepared vertex storage while owning its optional contact and cross-fade buffers.

## World tile loading foundation

The core entry exports `TerrainWorld`, `WorldTile`, `validateTerrainWorld`, `WorldTileIndex` and `WorldStreamer<T>`. The Three entry adds `TerrainWorldScene`, `WorldAssets`, `TerrainLod` and `RuntimeMaterialLibrary`. Existing `.terrain` documents remain valid; a host supplies independently authored tile projects. The editor still edits one tile at a time. `/world.html` demonstrates bounded terrain, foliage, compressed material and collider residency over a deterministic 2 × 2 km landscape.

A manifest has `{ kind: 'terrain-world', version: 1, tileSize, tiles: [{ x, z, source }] }`. `source` is an opaque locator interpreted by the host. Validation returns an immutable copy, rejects duplicate cells, and limits metadata to 65,536 tiles with integer coordinates in ±1,000,000 and tile widths of 1–10,000 metres. Tile `(0, 0)` covers `[0, tileSize)` on X and Z. `TerrainWorldScene` validates tile dimensions and places centered tile origins at `((x + 0.5) * tileSize, 0, (z + 0.5) * tileSize)`. Adjacent tiles require matching height-grid resolution and shared-edge heights within 0.1 mm; incompatible candidates fail admission.

`WorldTileIndex.select(position, radius, maximum)` searches nearby grid cells, sorts by horizontal distance to the closest point on each cell, and returns a bounded nearest selection. Ties sort by Z then X. Radius zero selects the containing half-open cell; positive radii include tangencies. Requests spanning more than 65,536 grid cells are rejected instead of scanning an unbounded area.

```ts
import { WorldStreamer, validateTerrainWorld } from 'terrain-tools';
import type { WorldTileSource } from 'terrain-tools';

// Host-defined prepared resource type and loader, including cleanup/accounting:
declare const source: WorldTileSource<MyPreparedTile>;
const world = validateTerrainWorld(manifest);
const streaming = new WorldStreamer(world, source, {
  radius: 1500, // metres in the manifest's XZ space
  maxResidentTiles: 16,
  maxConcurrentLoads: 2,
  cpuByteLimit: 256 * 1024 * 1024,
  gpuByteLimit: 512 * 1024 * 1024,
});
streaming.update({ x: camera.position.x, z: camera.position.z });
// Repeat update as the view moves; use residentKeys/get(key) for borrowed values.
// At shutdown: streaming.dispose(); await streaming.whenIdle();
```

The host source returns `{ value, cpuBytes, gpuBytes, dispose() }`. It must clean up partial failures, honor `AbortSignal` promptly and provide a non-throwing disposer. Loaded resources transfer ownership to the streamer; values returned by `get()` are borrowed and must not outlive residency. Loading starts nearest-first. Completed resources are admitted in completion order, so tighter budgets can reject another desired tile even if it is nearer. Rejected and failed tiles appear in `errors` and wait for `retry(key)` or `retry()`; unchanged view updates do not retry them automatically. Cells leaving the selection are evicted. Cancellation holds its concurrency slot until the source settles, and late results are disposed. `whenIdle()` waits for active/cancelled loads to settle; failures are reported through `errors`, not promise rejection.

Byte budgets bound **reported retained resource bytes**, not total process/GPU memory or renderer overhead. Load concurrency is separately bounded. There is no prefetch hysteresis yet. `stats` exposes resident/loading/queued/failed tile counts and admitted CPU/GPU bytes.

```ts
import {
  TerrainWorldScene,
  WorldAssets,
  createModelDecoder,
} from 'terrain-tools/three';
const decoder = createModelDecoder(renderer, '/basis/');
const assets = new WorldAssets(undefined, decoder.decode);
const worldScene = new TerrainWorldScene(manifest, {
  assets,
  radius: 340,
  maxResidentTiles: 12,
  maxConcurrentLoads: 2,
  cpuByteLimit: 768 * 1024 ** 2,
  gpuByteLimit: 768 * 1024 ** 2,
  lod: { pixelError: 2, transitionSeconds: 0.2 },
  load: async (tile, signal) => readAuthoredTile(tile.source, signal),
  // collision: createWorldCollisionSource(initializedRapierWorld),
});
scene.add(worldScene);
// Each frame, before environment/render/physics work:
worldScene.update(camera, deltaSeconds, drawingBufferHeight);
// At shutdown, before freeing an optional host Rapier world:
worldScene.dispose();
await worldScene.whenIdle();
assets.dispose();
decoder.dispose();
```

`heightAt(x,z)` returns the authoritative resident height in manifest coordinates, or `undefined` for an unloaded cell. Rendering LOD shares full-resolution positions, normals and weights and changes index topology; it retains every chunk boundary vertex, morphs interior heights and leaves chunks containing holes at full detail. Its metric is maximum **sampled** vertical error projected to drawing-buffer pixels, with 20% hysteresis. It is not a rigorous bound at every triangle intersection. Edge normals sample neighboring resident tiles. Collision always uses the original topology. Material palettes/paint must themselves be authored continuously across boundaries.

Tiles are immutable while resident; unload/reload after edits. Hosts can translate the world group for a floating render origin, while height queries and the Rapier adapter retain manifest coordinates. Hosts must coordinate physics-origin shifts themselves. The optional adapter creates disabled colliders, activates them at tile admission and removes them on eviction/cancellation. It does not provide a world editor, actor streaming or floating-origin physics.

`WorldAssets` leases share decoded models, immutable transformed foliage geometry and GPU textures. Per-batch instance attributes and per-tile effect uniforms remain independent. The content cache reserves candidate CPU/GPU/scratch estimates before decoding; active leases cannot be evicted. Unleased assets evict oldest-first under pressure, and `trim()` releases all unleased entries. Default model reservations are 128 MiB CPU and GPU each, configurable by the host; oversized decoded results are rejected and disposed. These are accounting limits, not an OS allocator guard. Hashing, host input documents, worker/WASM heaps and driver/program overhead are not completely measured. Per-tile counters conservatively count some shared buffers again; do not add them to unique cache counters as if they were exact process memory. Both steady and peak staging estimates are exposed.

Streamed oceans use finite per-cell patches with a shared world wave phase/time and no internal boundary walls. The current ocean-connectivity flood remains tile-local: author coast tiles accordingly. Arbitrary connected basins spanning multiple tiles need a world-wide hydrology/preparation layer; this example does not establish that capability.

## Prepared runtime assets

`npm run build:assets:runtime` creates `public/runtime-assets` from checked-in CC0 pine/fern derivatives and the separately credited generated Upland ground images. It preserves source hashes, authors/license references, bounds, existing mesh LODs and low-detail collision-input references in `manifest.json`. Meshopt compresses geometry; KTX2 uses UASTC quality 3, mipmaps and no RDO, with sRGB color and linear normal/ORM/height settings. It is deliberately quality-oriented: these sample GLBs download **larger** than the PNG originals, while GPU texture storage falls substantially. The original material/mesh derivatives remain in their existing source locations. Encoded output and wall-clock preparation timing are separate so the manifest can reproduce byte-for-byte.

The reusable library does not copy browser support files. Hosts using compressed models must serve the version-matched `public/basis` transcoder and its Apache-2.0 notice, then pass `createModelDecoder(renderer, path).decode` through `TerrainScene`, `loadTerrain`, or `WorldAssets`. The editor and import preview configure this automatically. Model decoding supports Meshopt and KTX2; disposal drains active workers and rejects late results. Static GLB limits remain unchanged.

`RuntimeMaterialLibrary(renderer, manifest.materials, baseURL, transcoderPath)` owns the array decoder. Set `assets.materials = library`, then assign `project.materials = library.palette([0,1,2,3])` (any four valid indices), and set the matching `project.view.textureResolution`. The eight-layer sample shares four compressed array textures across different active palettes. Inputs, dimensions, declared byte lengths and SHA-256 hashes are checked before activation. Map/scalar editing is still a single-tile authoring workflow; rebuild a prepared library after changing its source maps. Dispose tiles and assets, await their pending work, then dispose the library. See `src/examples/world.ts` for complete ownership and optional physics wiring.

## Prepare, cancel, and replace a scene

For a new scene, pass an optional signal to `loadTerrain(input, { signal })`; cancellation rejects with an `AbortError` and disposes the unfinished scene. Pass the same signal to your own `fetch` if the download should also stop.

For an existing scene, `await terrain.load(candidate, true, signal)` returns `true` on success or `false` when cancelled or superseded by a newer load. Preparation failures reject. Model/surface resources, all terrain chunks, foliage batches, and prop objects are built off-scene before replacement. A recoverable construction/allocation failure retains the current project, meshes, and resources. Use an independent candidate; do not mutate the live project before loading it.

Hosts that must check a document revision or coordinate their own lighting/history can stage the work explicitly:

```ts
const prepared = await terrain.prepareLoad(candidate, true, signal);
let colliders;
try {
  colliders = physics?.prepare(
    candidate,
    undefined,
    terrain.preparedPropCollision(prepared),
  );
  if (!signal.aborted && revision === currentRevision) {
    terrain.assertPrepared(prepared);
    if (colliders) physics!.assertPrepared(colliders);
    terrain.applyPrepared(prepared);
    if (colliders) physics!.apply(colliders);
  }
} finally {
  colliders?.dispose();
  prepared.dispose();
}
```

Preparation results belong to the scene that created them and can be applied once. Applying transfers ownership; `dispose()` then does nothing. Abandoning a result releases its resources. A resolved result remains the caller's responsibility even if its signal later aborts or its scene is disposed. Keep its candidate unchanged until the decision to apply or discard it. A terrain rebuild after preparation invalidates its geometry revision; prepare again instead of applying a stale result. Call `assertPrepared()` before committing external history. The editor also prepares picking meshes and enabled-physics replacements before changing its document or undo stacks.

A material can set `reduceTiling: true` to blend offset texture patches consistently across its color, normal, ORM, and height maps. Omitted or false preserves regular tiling. The setting is included in surface presets and authored exports; see [material tradeoffs](MATERIALS.md#reduce-visible-repetition).

Unchanged model payloads and surface arrays are shared through retained references. Replacements and removals release geometry, materials, textures, and owned image bitmaps when the last owner releases them. Embedded GLB dependencies use isolated URLs so cleanup does not close images in a host application's Three.js cache. Missing embedded textures fail preparation; external model dependencies are rejected.

These guarantees cover recoverable exceptions during decoding and CPU geometry/collider construction. They do not recover a terminated browser or lost graphics device, or exceptions thrown by host event listeners/lighting code during commit. The editor additionally validates native shader/texture preparations before committing project loads, surface edits and structural water edits. Standalone `TerrainScene` preparation remains independent of a renderer; a host must stage its own GPU work before committing if it needs the same guarantee. Preparation temporarily retains both old and replacement buffers. Cancellation stops pending requests and later channel allocations; synchronous decoding or geometry work already executing cannot be interrupted. The `materials = false` option intentionally retains the current terrain surface maps and is appropriate only when those maps are unchanged.

## Undo and redo

The core exports `History`, `PreparedHistory`, `HistoryOptions`, and `HistoryStats`. Call `history.checkpoint(project)` before a committed edit. `new History({ limit: 64, byteLimit: 256 * 1024 * 1024 })` uses the editor defaults; `new History(24)` remains supported, and a zero step limit disables history. Synchronous clients can use `history.undo(project)` / `redo(project)`.

For rendered scenes, stage the restore so a failed or cancelled asset load does not consume an undo step:

```ts
import { History } from 'terrain-tools';

const history = new History();
// Before each edit: history.checkpoint(project);
const restore = history.prepareUndo(); // prepareRedo() works the same way.
if (restore) {
  let prepared, colliders;
  try {
    prepared = await terrain.prepareLoad(restore.project, true, signal);
    colliders = physics?.prepare(
      restore.project,
      undefined,
      terrain.preparedPropCollision(prepared),
    );
    signal.throwIfAborted();
    terrain.assertPrepared(prepared);
    if (colliders) physics!.assertPrepared(colliders);
    project = restore.commit(project);
    terrain.applyPrepared(prepared);
    if (colliders) physics!.apply(colliders);
  } finally {
    colliders?.dispose();
    prepared?.dispose();
    restore.dispose();
  }
}
```

Keep `restore.project` unchanged while preparing resources. Commit returns this same object, invalidates the preparation, and rejects if history changed in the meantime. Dispose candidates after cancellation or failure. The older `undoTarget` and `redoTarget` getters return independent inspection copies; do not use them as renderer candidates for a separate `undo()` call.

Unchanged data and embedded assets are shared internally; restored mutable buffers and objects are independent. `history.stats` reports undo/redo counts, estimated retained bytes, configured limits, evicted states, and `overBudget`. The budget covers retained CPU snapshots, excluding live documents, temporary restore candidates, and GPU assets. It expires the farthest states but always keeps one available state, which can exceed the budget. `clear()` releases all retained history and invalidates pending restores. History is session-local and is not included in saved projects.

## Optional Rapier adapter

```ts
import { TerrainPhysics } from 'terrain-tools/rapier';

const physics = new TerrainPhysics();
await physics.init(); // Finish initialization before the first simulation step.
physics.rebuild(terrain.project);
physics.setPropMeshes(terrain.collisionMeshes(true, false));

const body = physics.drop(0, 30, 0, 1);
physics.step(deltaSeconds);
const touchingTerrain = physics.touchesTerrain(body);
// Use actual ground contacts to drive the foliage field.

physics.dispose();
```

Terrain and prop collider replacements allocate disabled candidates first. Failed preparations remove only the candidates; existing collider handles and bodies remain valid. `physics.prepare(project, region?, propMeshes?)` stages terrain and optionally props together; `apply()` enables the replacements and removes old colliders without a simulation step between them. An omitted `propMeshes` preserves existing props; an empty array removes them. Dispose abandoned candidates, including after cancellation. Another collider replacement makes an older preparation stale. Simulation steps and dynamic bodies can continue while candidates are staged.

The installed Rapier 0.19.3 declarations use extensionless relative imports and fail TypeScript's strict NodeNext declaration checking. The adapter and its staged APIs are verified with `moduleResolution: "Bundler"` and library checking enabled; core/Three-only consumers also pass strict NodeNext. This is an upstream declaration compatibility limit, separate from runtime collision behavior.

The adapter's heightfield coordinates match an untransformed terrain group. For a different engine or transformed scene, `terrain.collisionMeshes()` returns indexed world-space triangle meshes, including props and excluding terrain holes. `collisionMeshes(false)` returns only terrain; `collisionMeshes(true, false)` returns only props. The Rapier adapter uses static triangle meshes, fixed 60 Hz steps, friction, and CCD on its sample dynamic bodies. Terrain chunks request `TriMeshFlags.FIX_INTERNAL_EDGES` to correct adjacent-triangle contact normals; prop meshes keep their existing behavior. A reproduced flat-ground case previously gave a stationary drop several metres of sideways motion; edge correction keeps it at rest through 900 steps. The tests also cover chunk seams, several body radii, real holes and prop support. See [contact evidence](benchmarks/terrain-contact-correction-2026-10-15.json) and [Rapier’s flag definition](https://rapier.rs/javascript3d/enums/TriMeshFlags.html). Character controllers, vehicle tuning, and engine-specific simulation validation remain application responsibilities.

## Update terrain at runtime

For water visibility/height, wireframe, or flat shading, edit `terrain.project.view` and call `terrain.refreshView()`. It updates the existing water mesh and terrain material without replacing terrain, foliage or prop geometry. It does not rebuild collision or reset contact recovery. Changing flat shading invalidates the material shader only when that flag changes. After changing wind or contact settings on the retained project, the next `terrain.update()` reads them automatically.

```ts
import { applyBrush } from 'terrain-tools';

applyBrush(terrain.project, stroke);
const region = {
  minX: stroke.x - stroke.radius,
  maxX: stroke.x + stroke.radius,
  minZ: stroke.z - stroke.radius,
  maxZ: stroke.z + stroke.radius,
};
terrain.rebuildTerrain(region);
terrain.reanchorFoliage(region);
terrain.reanchorProps(region);
physics.rebuild(terrain.project, region);
```

Each `rebuildTerrain()`, `rebuildFoliage()`, and `rebuildProps()` builds its replacements before discarding its current resources. Regional terrain rebuilding commits all affected chunks together and retains untouched mesh identities. For coordination with external picking or collision, use `prepareTerrain(region)`, inspect `prepared.value.meshes`, validate with `assertTerrain()`, then `applyTerrain()`; always dispose abandoned preparations.

These individual rebuilds do not roll back prior mutations to the project, other completed rebuilds, or in-place anchor updates. Use an independent candidate and staged full-scene loading when the entire edit must succeed together. Editor sculpt, hole/fill, surface-paint and foliage paint/erase strokes now use retained-state transactions. Allocation failures, Escape, and pointer cancellation restore the committed buffers, meshes, picking and anchors without rebuilding. History and static collision change only when a stroke succeeds; a failed stroke preserves its redo branch. Erosion previews and application also retain the committed scene and stage collision/history before applying. Editor prop placement, handle/numeric transforms, cutout changes and removal also prepare an independent candidate and combined terrain/prop collision before history changes. Recoverable failures preserve the committed document, displayed mesh pose, selection and next instance ID. Foliage brush definitions, model removal, population and per-brush clearing also stage independent brush/instance records and any replacement draw buffers before history changes. Metadata that only affects future placement avoids rebuilding existing plants. Editor surface controls, map/ORM imports, presets, placement rules and paint clearing also stage material and any terrain/picking resources before history changes. Shading-only controls retain geometry; surface edits preserve foliage, props and colliders. Generation and heightmap import now stage an independent landscape and its terrain, foliage, props, picking and collision before capturing history; cancellation and failures preserve the previous scene and test bodies. Regeneration retains reusable brush definitions, imported assets and authored settings. World wind/contact/display edits and sculpt numeric settings now preserve the committed document and redo if history capture fails. World edits retain the live geometry and physics bodies. Lighting preparation/history failures restore controls and release unused candidates.

Topology edits (hole/fill) also need `rebuildFoliage()` to update visibility. Changes to brush definitions or instance populations need `rebuildFoliage()`. Prop changes need `rebuildProps()` plus a prop-collider refresh. Material rule changes need geometry weight updates; texture/color/roughness changes go through `await terrain.terrainMaterial.update(project)`. Use `await terrain.load(project)` when replacing the entire document.

## Reversible geometry previews

`terrain.beginEdit(candidate)` retains the current terrain buffers, foliage state and prop objects while displaying an independent candidate. Rebuilds and reanchoring can then preview several dabs. `commit()` releases the replaced originals; `rollback()` or an uncommitted `dispose()` restores them. The group identities stay stable. Retained foliage continues updating wind, contact recovery and camera-dependent detail so cancellation does not rewind animation. The exported `EditTransaction` type describes this one-shot handle.

```ts
const original = terrain.project;
const candidate = structuredClone(original);
const edit = terrain.beginEdit(candidate);
let colliders;
try {
  applyBrush(candidate, stroke);
  terrain.rebuildTerrain();
  terrain.rebuildFoliage();
  terrain.rebuildProps();
  colliders = physics?.prepare(
    candidate,
    undefined,
    terrain.collisionMeshes(true, false),
  );
  if (colliders) physics!.assertPrepared(colliders);
  history.checkpoint(original);
  if (colliders) physics!.apply(colliders);
  edit.commit();
} finally {
  colliders?.dispose();
  edit.dispose(); // Rolls back if construction or history capture failed.
}
```

Keep the original project unchanged and use independent mutable buffers/instance arrays in the candidate. Assets and material resources must stay unchanged during this geometry-only preview; finish it before loading another project or replacing models/maps. Nested scene edits are rejected. The primitive manages rendering resources, while the host coordinates history and physics as above. The editor additionally retains its picking meshes, pauses publication of candidate data to autosave, and ends the current stroke before save/export or tool changes.

For repeated water-enabled dabs, opt into `terrain.prepareTerrain(region, candidate, { waterPreview: true })`, apply the prepared geometry, and dispose the preparation handle. This requires an active `beginEdit()`. Only affected height rows are copied into the water height field; connectivity, wet banks and caustic fields retain their previous state during the stroke. Three.js still uploads the whole height texture. Keep terrain dimensions and water settings unchanged. **Call `terrain.finalizeWaterPreview()` before checkpointing history and committing the edit.** It computes complete water connectivity and shoreline fields once, checks basin spills, and may throw; `edit.rollback()` restores the retained water fields without repeating the failed preparation. Ordinary `rebuildTerrain()` and preparation without the option retain immediate water updates. Finalization remains synchronous.

Preparation clones the foliage draw state once per stroke and retains both states temporarily. This adds measurable startup latency and memory; large-population optimization remains open. See [preview measurements](PERFORMANCE.md#reversible-edit-preview).

## Prop cutouts

Legacy props without `cutout` use `holeRadius * scale`. A rectangle instead uses model-local dimensions and centre offsets:

```ts
prop.cutHole = true;
prop.cutout = {
  shape: 'rectangle',
  width: 12,
  depth: 5,
  offsetX: 2,
  offsetZ: 0,
};
prop.rotation = Math.PI / 4; // Y rotation, radians.
prop.scale = 1.5;
terrain.rebuildTerrain();
terrain.rebuildFoliage();
terrain.rebuildProps();
physics?.rebuild(terrain.project);
physics?.setPropMeshes(terrain.collisionMeshes(true, false));
```

The core exports `propFootprint(prop)` for transformed bounds, point containment, and a ground-plane outline; `effectiveHoles(project)` composes all enabled prop cutouts with painted holes. `fitPropCutout(bounds, minimumExtent)` creates a validated rectangle from local X/Z bounds. `terrain.library.bounds(modelId)` supplies decoded Three.js model bounds, including node transforms. The editor uses at least one terrain cell for a fitted footprint's world width/depth. Smaller hand-authored cutouts may cover no cell centres.

Footprints persist in native packages, legacy JSON, and embedded GLB authoring data. They remove complete terrain cells, preserve painted holes, and do not cut the prop mesh itself. Fitted bounds are an editable snapshot: fit again after changing a source model. Footprints support circles and rectangles. Model fitting approximates concave silhouettes with projected bounds.

## Interchange guarantees

GPU-compressed foliage imports retain their original GLB payload in the editable document. Presentation export decompresses their maps to ordinary image textures using an owned temporary renderer, so standard glTF viewers do not need the runtime's KTX2 loader. The temporary renderer and textures are disposed on success, failure or cancellation; the live viewport and borrowed source textures remain unchanged.

`exportTerrainGLB(terrain)` writes a standard static presentation and an optional `TERRAIN_tools_project` extension. Version 2 of the extension references a binary `.terrain` package in a GLB buffer view. It retains schema-version-1 project data, embedded image/GLB assets, all foliage and prop instances, rules, hole masks, lighting/HDRI, wind, and response settings. Readers also accept the older version-1 inline extension. See [project files and encoding APIs](PROJECT-FILES.md). `projectFromGLB` validates this document without decoding the presentation meshes. Ordinary GLB viewers ignore the extension and see the static geometry. Default exports use baked terrain colors; `exportTerrainGLB(terrain, { surface: 'pbr', renderer, resolution: 2048 })` adds standard base-color, ORM, and normal atlases. Full procedural appearance and animation require this runtime. See [PBR export](EXPORT.md) for ownership, cancellation, and sampling limits.

This is an authoring-state round-trip. Transient physics bodies and currently compressed plant poses are not part of the editable document. The static GLB presentation includes every primary foliage instance regardless of camera/LOD/density selection, and may reflect the current whole-plant transform pose. Masked foliage exports its rest pose; wind is not baked. Loading the authored project resets transient interaction. Direct callers of `foliage.forExport()` own the returned meshes, cloned geometries, and cloned static materials (dispose each unique resource once). Textures remain borrowed from the live scene. Transient fade attributes and shader hooks are excluded, so the group can also render as a complete static presentation.

## Streaming preparation and shader admission

`TerrainWorldScene` defaults to worker terrain preparation when `Worker` is available. Its bounded pool uses up to eight workers (limited by `maxConcurrentLoads`), with a 32-job pending limit and a 120 s job timeout. Workers receive copied height/paint/hole buffers and small authoring metadata, never embedded GLBs, HDRIs or surface image payloads. They return transferable chunk geometry, normals, bounds and terrain LOD/morph bounds. Live project arrays remain owned by the caller. Aborting active work terminates that worker; disposal rejects queued work and releases the pool. Non-browser hosts retain main-thread preparation; `terrainPreparation: 'main'` requests it explicitly. `/world.html?main-thread` exposes that comparison.

Tile preparation yields between material, geometry and foliage stages. The optional async `prepareGPU(terrain, signal)` world hook runs after geometry/LOD preparation and before collision/residency admission. Hosts can serialize renderer compilation there, as `/world.html?prewarm` does with `renderer.compileAsync(terrain, camera, scene)`. The example leaves this off by default because precompilation delayed visible tile admission in measurements. Fallible work stays outside the resident scene; failure/cancellation releases staged resources before retry. This precompiles native material graphs; it does not promise that all MRT, shadow or future quality variants have warmed. Uploads, physics and asset decode can still hitch.

Identical wind/fade/transmission configurations reuse bounded node graphs across tiles while material references retain each tile's independent animation uniforms. Distant draw clustering is enabled by default; `foliageClusters: false` disables it. These options are runtime behavior and do not alter saved documents.
