# Runtime integration

Build with `npm run build:runtime`. To use the toolkit from another local project, run `npm pack` in this repository and install the generated tarball there. The package is private and this command does not publish it. It includes JavaScript, TypeScript declarations, and documentation. Reference-scene art and native packages belong to the editor build in `dist/examples/`; the reusable library build does not copy `public/` assets.

Three.js r180 is a peer dependency so the host and toolkit use the same Three instance. Rapier is optional: consumers can omit optional dependencies when using another physics engine. Importing the core or Three entry does not initialize or load the physics engine.

For strict TypeScript checks of the Three.js entry point with `skipLibCheck: false`, include `"@webgpu/types"` in your compiler's `types` array alongside any other required global types. The installed r180 Three.js declarations reference `GPUTexture`; those WebGPU declarations are required even when the application renders with WebGL. The package compatibility check uses `module` and `moduleResolution` set to `NodeNext`, `target: "ES2022"`, and the `ES2022`/`DOM` libraries.

## Load an authored scene

```ts
import { loadTerrain } from 'terrain-tools/three';

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

Pass a `.terrain` package ArrayBuffer or legacy JSON text to load a saved project directly; ArrayBuffer inputs are detected by signature. Browser hosts can pass a File or Blob directly for bounded reads. `loadTerrain` validates and decodes assets before returning. The host supplies the renderer, camera, render loop, and game objects. It can provide its own lighting or restore authored lighting with `TerrainEnvironment`; see [lighting integration](ENVIRONMENT.md). Set renderer shadows to use the runtime's wind-deformed foliage shadows. The standalone `/runtime.html` example uses these package exports, not the editor's UI classes.

With authored environment rendering, call `lighting.tick(deltaSeconds)` and `lighting.render(camera)` after `terrain.update()`, replacing the direct renderer call above. This applies optional camera-following sun cascades, contact occlusion and temporal stabilization. `lighting.updateCamera(camera)` provides cascades alone for hosts supplying their own screen compositor. Request `powerPreference: 'high-performance'` when constructing a desktop renderer, and record the actual selected GPU when profiling; browsers may override the preference. See the environment guide for full-viewport and material ownership constraints.

All authored positions use local metres, XZ ground, and Y up. `terrain.update(dt, contacts)` expects local ground-contact X/Z coordinates. Each contact has `{ x, z, radius, strength }`. Supply an empty array when contacts stop; compressed foliage recovers over time. Convert world contacts to terrain-local coordinates if the host transforms the group. Authoring exports use terrain-local coordinates; host scene placement is separate game state.

`project.size` is the square side length in metres; `project.resolution` counts cells per side. For example, `createProject(512, 512)` creates 512 × 512 cells over 512 × 512 metres. `resizeTerrain(project, size, scaleElevation = true)` returns a candidate without changing the source: grid resolution, paint and holes remain; terrain elevation and water level scale unless disabled. Prop/plant XZ positions scale, while their dimensions, surface rules and texture repeats remain in metres. Unchanged buffers and metadata are shared, so stage the candidate with `terrain.prepareLoad` and commit it before further editing. `project.view.eyeHeight` stores the editor's first-person camera height in metres; `parseEyeHeight` validates 0.1–100 m and supplies `DEFAULT_EYE_HEIGHT` (1.8 m) for older projects. These values persist in JSON, native packages and editable GLBs; host applications provide their own character controller.

Passing a camera as the third argument enables authored foliage LOD, density thinning, and far culling. Camera positions are converted to terrain-local space, including parent transforms. Omitting the camera leaves the current selection unchanged; a newly loaded scene starts at full primary detail. Use `terrain.foliage.updateView(camera)` separately when needed, or `terrain.foliage.resetView()` for a full-detail comparison. `terrain.foliage.viewStats` reports selected instances, culled instances, selected batch meshes, triangle count, and counts per LOD before frustum culling. With a positive per-model `lodFadeDuration`, `transitioning` counts plants in a timed fade and `drawnInstances` counts their submitted representations across all LODs. The sum of `levels` can exceed the unique `instances` during overlap. Keep calling `terrain.update(dt, contacts)` to advance existing fades, even when the camera is stationary or selection is handled separately with `updateView(camera)`. Time uses the supplied delta in seconds. Initial selection and `resetView()` are immediate. Call `rebuildFoliage()` after changing LOD or flexibility-mask settings. Per-model `flexibility` selects height, a vertex-color channel, or an imported scalar mask; see [plant flexibility](FOLIAGE.md#shape-plant-response). Masked instances retain their anchor transform; sparse contact updates write a scalar per drawn instance. Each batch shares prepared vertex storage while owning its optional contact and cross-fade buffers.

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

These guarantees cover recoverable exceptions during decoding and CPU geometry/collider construction. They do not recover a terminated browser, WebGL context loss or GPU upload failure, or exceptions thrown by host event listeners/lighting code during commit. Preparation temporarily retains both old and replacement buffers. Cancellation stops pending requests and later channel allocations; synchronous decoding or geometry work already executing cannot be interrupted. The `materials = false` option intentionally retains the current terrain surface maps and is appropriate only when those maps are unchanged.

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

`exportTerrainGLB(terrain)` writes a standard static presentation and an optional `TERRAIN_tools_project` extension. Version 2 of the extension references a binary `.terrain` package in a GLB buffer view. It retains schema-version-1 project data, embedded image/GLB assets, all foliage and prop instances, rules, hole masks, lighting/HDRI, wind, and response settings. Readers also accept the older version-1 inline extension. See [project files and encoding APIs](PROJECT-FILES.md). `projectFromGLB` validates this document without decoding the presentation meshes. Ordinary GLB viewers ignore the extension and see the static geometry. Default exports use baked terrain colors; `exportTerrainGLB(terrain, { surface: 'pbr', renderer, resolution: 2048 })` adds standard base-color, ORM, and normal atlases. Full procedural appearance and animation require this runtime. See [PBR export](EXPORT.md) for ownership, cancellation, and sampling limits.

This is an authoring-state round-trip. Transient physics bodies and currently compressed plant poses are not part of the editable document. The static GLB presentation includes every primary foliage instance regardless of camera/LOD/density selection, and may reflect the current whole-plant transform pose. Masked foliage exports its rest pose; wind is not baked. Loading the authored project resets transient interaction. Direct callers of `foliage.forExport()` own the returned meshes, cloned geometries, and cloned static materials (dispose each unique resource once). Textures remain borrowed from the live scene. Transient fade attributes and shader hooks are excluded, so the group can also render as a complete static presentation.
