# Sculpting and heightmap exchange

Brush preset names, alpha selection, stamp values, pen-pressure settings, and thermal slope are staged before creating an undo step. If history capture fails, the controls return to their previous values and the document, autosave and redo branch remain intact.

The Sculpt inspector is organized into **Brush** (tools, brush settings, alpha/stamps), **Terrain** (generation, weathering, reference landscape) and **Files** (heightmaps and sculpt presets). Flatten/terrace targets and erosion slope controls appear only for their corresponding tools.

## Generate a starting landscape

Choose Alpine ridges, Dune field, Island chain or Flat canvas, a 32–512 cell grid, and an integer seed. Seed 0 is valid; accepted seeds range from −2147483648 to 2147483647. **Generate landscape** replaces the height grid, holes, painted coverage and placed foliage/props. It keeps surfaces and maps, foliage brush definitions, imported assets, sculpt/erosion settings, lighting, wind, interaction and view settings, so you can reuse an authored palette on a new landform.

Generation prepares the complete replacement before changing the project or history. Cancel pending preparation to keep the current scene. A recoverable buffer, picking, collision or history-capture failure also keeps the old scene, selection, physics preview and redo branch. Retry with the same settings, or reduce the grid resolution. Success creates one undo step and clears the previous test bodies.

## Shape and stamp terrain

Raise, Lower, Smooth, Flatten, Terrace, Noise, and Erode remain continuous brushes. Select **Soft radial** for their original radial falloff, or choose a rounded hill, ridged peak, crater rim, or imported PNG alpha. White alpha values apply the strongest effect; black values mask ordinary brushes. Alpha rotation follows the terrain Y axis.

**Stamp** applies once per pointer press. Move to another location and press again for another stamp. Radius is half the square stamp width. **Add** and **Subtract** use alpha × stamp height × strength; **Set** blends toward base elevation + alpha × stamp height, with strength and edge falloff controlling opacity. In Set mode, black pixels set the base elevation. All results stay within the terrain’s height bounds.

PNG alphas retain their numeric precision and multiply image opacity into the mask. Images larger than 512 pixels per side are resampled proportionally. Custom alphas and stamp settings are stored in project JSON, autosaves, and scene GLB; they also survive terrain generation. Their small preview and the rotated viewport outline show the current shape and footprint.

Brush input uses fixed 60 ms time steps with interpolated dabs, so application rate does not depend on rendered frame count. Fast motion distributes each time step’s strength among intermediate dabs. Pen pressure scales strength when enabled; mouse input uses full pressure. Starting a drag over empty space begins the editable candidate on the first terrain hit; successful release creates one undo checkpoint. Re-entering terrain does not draw a bridge across missing hits. A long pause discards accumulated idle time.

## Cancel or recover a stroke

Press **Esc** while holding a stroke to restore the terrain from before the press. Pointer cancellation does the same. This also applies to Cut hole / Fill hole, surface painting and foliage paint/erase. A recoverable geometry, picking, foliage, collision or history-preparation failure cancels the stroke automatically and reports the error. Existing undo and redo steps remain available; retry after reducing the workload if the failure persists.

Autosave continues using the committed project during a stroke. Releasing successfully updates collision and adds one undo step. Save/export and switching tools finish the current stroke first. Retained foliage keeps advancing wind and contact recovery while you preview an edit. Large foliage populations add startup time and temporary memory; see [measured preview costs](PERFORMANCE.md#reversible-edit-preview).

## Reuse sculpt presets

In **Sculpt presets**, name the brush and choose **Save preset** to download a `.sculpt.json` file. **Load preset** selects its tool and restores radius, strength, falloff, target/terrace step, erosion stable slope, alpha rotation, stamp settings, and pressure behavior. The file embeds a loaded custom alpha at its full Float32 precision, including when a built-in shape is selected. It contains no terrain, foliage, props, surface maps, or other weathering settings.

Loading makes one undoable settings change; it does not sculpt until the next stroke. Invalid files and reads that finish after another edit leave the current settings intact. Brush controls also persist in native projects, JSON, autosaves, and embedded GLB projects. Returning from another editor tab restores the selected sculpt tool and its controls. Older projects use Raise, 12 m radius, strength 1, falloff 0.65, and target 10 m.

Preset files are versioned JSON, limited to 8 MiB with custom alphas up to 512 × 512 samples. Distances are in metres; alpha rotation is in degrees. A preset keeps its numeric elevations on another terrain; actual edits still clamp to that terrain’s height bounds. Noise uses the destination project/stroke seed, and results also depend on the destination surface and grid spacing.

```ts
import {
  serializeSculptPreset,
  parseSculptPreset,
  defaultSculptSettings,
  defaultErosionSettings,
} from 'terrain-tools';

const text = serializeSculptPreset(
  project.sculpt ?? defaultSculptSettings(),
  project.erosion?.talus ?? 35,
);
const preset = parseSculptPreset(text); // Validates and owns independent alpha data.
// Capture history before replacing settings in an editor.
project.sculpt = preset.settings;
(project.erosion ??= defaultErosionSettings()).talus = preset.talus;
// Apply brush settings with applyBrush; loading a preset does not edit geometry.
```

## Bring in elevation data

Use **Heightmap exchange** in Sculpt. Set the elevation represented by black and white, then import a PNG or RAW16 file. Imports resample to the current vertex grid: a 128-cell terrain has 129 × 129 vertices. Generate a terrain at the desired resolution first when a different grid is needed.

Imports replace heights and preserve holes, material definitions, paint, foliage, props and settings. New terrain/picking buffers, anchored objects and collision prepare before committing one undo step. Invalid files, failed preparation/history capture and cancelled or superseded reads retain the current scene, physics preview, selection and redo branch. Use the preparation bar’s **Cancel** button during a pending read; a new generation or document edit also discards that request. Successful import clears previous test bodies and resumes collision on the new surface.

- **PNG:** non-interlaced grayscale, RGB, RGBA, and indexed images are supported, including 16-bit grayscale/RGB data. Color images use weighted RGB luminance. Image profiles and display gamma are ignored because samples represent numeric elevation. Height imports ignore opacity; alpha-brush imports use it. Animated and interlaced PNGs are rejected with a specific message.
- **RAW16:** unsigned 16-bit samples, with explicit source width, height, and byte order. The byte length must match exactly. Both little and big endian are supported.
- Images may contain up to 16,777,216 samples, with each side at most 8192 pixels. Files are limited to 64 MB. Decoding also limits decompressed output to the declared dimensions.

The first image row maps to negative terrain Z; columns increase toward positive X. **Flip image rows on import** reverses the Z direction. Input height bounds must lie between negative and positive terrain size, in metres.

## Export elevation data

**Fit range to terrain** finds black/white elevations covering the current terrain. Export creates a grayscale 16-bit PNG or RAW16 at the current vertex-grid size. The filename records the height range and grid width. Keep these values when importing into another tool; RAW files also need byte order and dimensions.

Values outside the chosen range are clipped. The quantization interval is (white elevation − black elevation) / 65535. These files contain heights only; use project JSON or scene GLB to retain holes, surfaces, placements, and authored behavior.

## Public API

The core heightmap function replaces the provided project’s height buffer. The direct rebuild example below assumes the host handles failures. For a recoverable whole-scene change, prepare an independent candidate and coordinate scene/collision application as described in [runtime ownership](RUNTIME.md#prepare-cancel-and-replace-a-scene).

```ts
import {
  decodeHeightmapPNG,
  applyHeightmap,
  terrainHeightmap,
  encodeHeightmapPNG,
  applyBrush,
  builtInAlpha,
} from 'terrain-tools';

const map = await decodeHeightmapPNG(fileArrayBuffer);
applyHeightmap(project, map, -20, 80);
terrain.rebuildTerrain();
terrain.rebuildFoliage();
terrain.rebuildProps();
physics?.rebuild(project);
physics?.setPropMeshes(terrain.collisionMeshes(true, false));

applyBrush(project, {
  tool: 'stamp',
  x: 0,
  z: 0,
  radius: 20,
  strength: 1,
  falloff: 0.2,
  target: 30,
  stampMode: 'add',
  rotation: Math.PI / 4,
  alpha: builtInAlpha('ridge'),
  material: 0,
  brushId: 'pine',
  seed: 42,
});
// Refresh terrain, anchored instances, and collision after editing.
const png = await encodeHeightmapPNG(terrainHeightmap(project, -20, 80));
```

The PNG codec follows the [W3C PNG specification](https://www.w3.org/TR/png-3/) and uses standard CompressionStream/DecompressionStream APIs. The core has no Three.js or physics dependency.

Use **Weather landscape** for cancellable hydraulic and thermal erosion with before/after comparison; see [erosion controls and behavior](EROSION.md). Validation with physical pen/touch devices remains a work item. These tools alone do not establish production photorealistic output quality.
