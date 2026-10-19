# Material authoring

Terrain Studio blends four PBR layers on one terrain. Select **Materials** and a layer to edit its surface and placement rules.

The Surfaces inspector has **Surface** for shading, **Maps** for imports and presets, **Rules** for automatic placement, and **Paint** for brush overrides. Select the layer above these tabs; the current settings page stays open when the layer changes.

## Import a complete texture set

Choose **Import PBR material** at the top of Materials, select **Made for / source format**, then drop or select all images for one surface together. PNG, JPEG, WebP, TIFF (`.tif`/`.tiff`) and TGA are supported. You can also choose the source format after adding files. The importer recognizes common base-color/albedo/diffuse, normal, AO, roughness/gloss, metalness, height and packed-map filenames. Every assignment is editable. Unrecognized images stay **Not used**; maps supplying the same output channel require a choice before previewing. ZIP and EXR texture maps are not accepted here; EXR is supported separately for environment lighting.

| Source format            | Normal default      | Numeric conversion                                                                   |
| ------------------------ | ------------------- | ------------------------------------------------------------------------------------ |
| Blender                  | OpenGL (+Y)         | Separate AO, roughness and metalness maps; named packed layouts are also recognized. |
| Unreal Engine            | DirectX (−Y)        | ORM/ARM: R = AO, G = roughness, B = metalness. RMA and MRA are also recognized.      |
| Unity — Built-in / URP   | OpenGL (+Y)         | Metallic map: R = metalness, A = smoothness. Separate occlusion reads G.             |
| Unity — HDRP Lit         | OpenGL (+Y)         | Mask map: R = metalness, G = AO, A = smoothness. Blue detail mask is omitted.        |
| Generic OpenGL / DirectX | Selected convention | Filename detection and editable channel assignments.                                 |
| Auto / custom            | OpenGL (+Y)         | Filename detection; ambiguous maps require manual assignment.                        |

All numeric inputs become this project's ORM layout: R = AO, G = roughness, B = metalness. Smoothness becomes `1 − smoothness`. RMA means R = roughness, G = metalness, B = AO; MRA means R = metalness, G = roughness, B = AO. The review shows the actual channel conversions beside each map. Unity metallic/smoothness can be combined with separate AO. Unity packed smoothness requires PNG, TIFF or TGA containing alpha; a missing alpha channel fails preview instead of silently making the surface smooth. If a Unity download contains a separate metallic image, assign **Metalness** and supply its separate roughness/smoothness image.

Presets describe common metallic workflows, not every shader. The Unity Built-in/URP preset assumes metallic-alpha smoothness, the [URP Lit default](https://docs.unity3d.com/6000.0/Documentation/Manual/urp/lit-shader.html); for albedo-alpha smoothness, export it as a separate smoothness image. HDRP follows the documented [Lit mask-map channels](https://docs.unity3d.com/Packages/com.unity.render-pipelines.high-definition@17.0/manual/Mask-Map-and-Detail-Map.html). Import extracted source textures, not `.unitypackage`, `.uasset`, `.blend`, shader graphs or runtime-compressed normal textures. Specular workflows and HDRP detail maps are not converted. Unknown custom masks stay unassigned so you can choose their layout.

1. Review the map roles and conversion summaries. TIFF/TGA thumbnails appear after **Preview material** decodes them. For separate AO, roughness and metalness images, select the source channel. PNG and TIFF numeric samples retain their precision until final 8-bit packing. Unassociated RGB beneath zero alpha is preserved in PNG/TIFF/TGA; JPEG/WebP channels are decoded without intentional color-space conversion. Gloss/smoothness names and Unity packed roles enable inversion; separate roughness stays roughness. Explicit GL/OGL/DX normal filenames override the source preset. Changing the preset updates automatic assignments and reapplies normal/gloss defaults while preserving manually selected roles and channels. Manual normal/gloss choices survive adding or removing files.
2. Set the name, coverage in metres, and project texture resolution. **Channel & replacement options** controls gloss inversion, white tint and whether omitted slots retain existing maps or return to procedural defaults. Supplied roughness/metalness channels use full-strength multipliers. The resolution selector affects all four terrain layers and displays their estimated texture-array memory.
3. Choose **Preview material**. Orbit/zoom the sphere and 4 m ground sample under neutral lighting. Dimensions and non-square resampling are reported beside it. Changing an input invalidates Apply until the preview is rebuilt.
4. Choose **Apply material**. This is one undo step; the layer's identity, coverage, placement rules and foliage references stay intact. Preparation/history failures leave the panel open for retry. Cancel/Escape discards the pending import. Save a surface preset afterward to reuse the result.

The preview uses the supplied maps and conventional UV shading. It does not reproduce terrain triplanar blends, height blending, procedural fallback maps or the scene's lighting. Inspect the applied terrain as the final check. Keep using the main inspector for roughness, metalness, normal strength, tint, anti-repetition and layer blending. Its map slots now show thumbnails; the × on a map removes only that map, with Undo available.

The import review accepts up to 24 images, each at most 256 MiB and 16,777,216 pixels (4096²). Decoded pixel count is the main per-image memory bound; the higher file allowance accommodates uncompressed 4K RGBA8 TGA (64 MiB plus its header) and RGBA16 TIFF (128 MiB plus metadata). PNG/JPEG/WebP dimensions are checked before browser thumbnails or decoding; TIFF/TGA worker decoders check dimensions before pixel allocation. The existing 384 MiB budget applies to distinct embedded assets across the entire project, including converted maps, models and environment images. Exceeding it rejects Apply without changing history. Files selected for channel packing are transferred to the worker without copying their buffers. Files are embedded locally; nothing is uploaded. Header/actions remain visible while the source list scrolls. See [verification evidence](benchmarks/asset-import-ux-2026-10-16.json) for tested fixtures, real assets and device limits.

Native projects, autosave and surface presets retain the converted ORM and normal convention. The original engine preset and separate channel files are not saved as an editable conversion recipe; reopening a project does not convert them again.

See [engine import verification](benchmarks/material-engine-import-2026-10-16.json) for exact channel fixtures, recovery checks and browser/asset limits.

Photoshop PSD maps are skipped with a persistent notice; export them as PNG before importing. This includes the metallic PSD in the `dirtwithrocks-ogl` set: its four 2048² PNG maps can be previewed and applied independently. With no roughness/metalness image supplied, adjust the layer's sliders after import.

If an older open editor reports **Channel packing failed**, refresh once to load the updated editor and select the maps again. Material and ORM previews now carry their image processor with the editor bundle, avoiding a missing worker file after rebuilding. Startup failures explain the retry action and leave the terrain unchanged. The real dirt-and-rock set was verified through preview, apply and autosave; see [import recovery evidence](benchmarks/environment-tabs-and-import-recovery-2026-10-16.json).

## TIFF and TGA texture formats

The complete-material importer, individual material slots and ORM composer accept `.tif`, `.tiff` and `.tga`, even when the operating system supplies no image MIME type. Conversion runs in a cancellable worker before changing the project. TIFF/TGA sources share the 256 MiB file allowance and 16,777,216-pixel limit (4096²) used by material imports. Their orientation is normalized before preview and channel packing.

- **TIFF:** first image of a classic TIFF, little or big endian; unsigned 8/16-bit grayscale or RGB/RGBA, and 8-bit indexed color. Strips and tiles support uncompressed, LZW, Deflate and PackBits data, including horizontal prediction. Samples must be interleaved (chunky). BigTIFF, floating-point/signed samples, CMYK, JPEG-compressed TIFF and camera RAW layouts require conversion to PNG first.
- **TGA:** uncompressed or RLE true-color (16/24/32-bit), indexed color, and grayscale (8-bit or 8-bit gray plus 8-bit alpha). Image-origin flags and TGA 2 alpha metadata are honored. Interleaved scanlines are unsupported. A 16-bit grayscale TGA stores gray plus alpha, not a 16-bit height sample; use 16-bit TIFF or PNG for precise numeric input.

Use sRGB source colors for albedo. Embedded ICC profiles and TIFF/TGA gamma metadata are not applied; numeric maps use stored sample values. Unassociated alpha preserves underlying RGB, including zero-alpha pixels. Associated/premultiplied alpha is unpremultiplied; color already lost under zero alpha cannot be recovered. Unity smoothness requires declared alpha, not an unspecified extra channel.

TIFF/TGA maps become embedded 8-bit PNGs for rendering, native projects, autosave, portable surface presets and export. Numeric TIFF channels retain 16-bit precision through ORM resampling and are quantized only when packing the final ORM. Height material maps still affect blending; terrain geometry heightmap exchange remains PNG16/RAW16. Multipage TIFFs import only the first image, and source files/metadata are not retained as an editable recipe.

See [larger texture import verification](benchmarks/texture-limits-2026-10-17.json) for the 64 MiB uncompressed 4K TGA round trip, dimension checks and recovery. Numeric PNG packing and TIFF/TGA conversion also require each side to be at most 8192 pixels.

See [TIFF/TGA verification](benchmarks/material-formats-2026-10-16.json) for byte-level fixtures, Chrome recovery scenarios and the 2048² real-material check.

## Safe editing and retry

Surface controls, map reset/import, ORM Apply, placement rules, and clearing painted overrides prepare their replacement resources before changing the project or undo history. A recoverable preparation or history-capture failure keeps the previous surface, paint, selection and redo branch. Correct the input or retry the same edit. Cancel stops a pending map load; another surface edit supersedes it.

Shading-only changes reuse terrain, foliage, props and collision. Altitude/slope rules, feathering and clearing paint prepare terrain weights and picking together; existing plants and colliders remain in place. New foliage placement uses the updated weights. Each successful action creates one undo step. These guarantees cover recoverable CPU/resource errors, not a terminated browser or lost GPU context.

## Surface inputs

| Map    | Meaning                                                                                                        |
| ------ | -------------------------------------------------------------------------------------------------------------- |
| Albedo | Base color, interpreted as sRGB and multiplied by the layer tint. Use a white tint to retain the source color. |
| Normal | Tangent-space detail; choose OpenGL (+Y) or DirectX (−Y) to match the source.                                  |
| ORM    | Numeric channels: red = ambient occlusion, green = roughness, blue = metalness.                                |
| Height | Numeric red-channel height used to blend layer boundaries. This does not displace terrain or change collision. |

Import PNG, JPEG, WebP, TIFF or TGA maps up to 16 megapixels and 256 MiB each. Every layer uses the project's **Texture resolution**, from 256² to 2048²; inputs are resized into square texture arrays. Higher resolutions cost GPU memory. **Texture scale** is the repeat size in terrain metres, shared by that layer's maps. Triplanar projection reduces stretching on slopes without terrain UV authoring.

Normal strength scales the lateral detail; zero disables it completely. DirectX reverses the green normal component before triplanar orientation. Choose the convention supplied with the texture set; this option does not rotate the image or convert an object-space normal map. Projects without the setting retain OpenGL behavior.

Roughness and metalness sliders multiply their ORM channels. A black metalness channel remains nonmetallic regardless of its slider. Occlusion affects indirect light. Missing imported maps use procedural defaults.

## Reduce visible repetition

Enable **Reduce texture repetition** for an individual layer to blend randomly offset patches of its source textures. Albedo, normal, ORM, and height use the same offsets and weights, anchored to terrain-local metres. Texture scale still controls feature size. The switch is undoable, travels with native projects and surface presets, and is included in baked PBR exports. Omitted or false retains the original repeating appearance; the supplied reference scene leaves it off so artists can compare.

This option is intended for natural, irregular ground such as soil, grass, and rock. It can soften contrast or duplicate recognizable features; leave it off for bricks, roads, labels, and other structured patterns. It does not repair non-seamless source images, change placement rules, displace geometry, or alter foliage eligibility.

Each enabled projection samples three offset patches instead of one. Existing texture arrays are reused, but GPU sampling work increases. Enable only the layers that benefit and compare close and distant views. [Measured costs](PERFORMANCE.md#surface-texture-variation) include a reproducible terrain-only GPU benchmark; they are not whole-editor frame budgets.

The implementation uses a triangular patch grid with normalized fourth-power weights and explicit texture gradients, related to [randomized triangular blending](https://jcgt.org/published/0011/03/05/paper-lowres.pdf). It translates samples without rotating them, so normal-map axis conventions remain unchanged. It does not implement histogram-preserving preprocessing; source maps stay unmodified. In the SDK, set `material.reduceTiling = true`, then update the terrain material or reload a prepared project.

## Build ORM from separate maps

1. Select **Build ORM from separate maps**.
2. Supply any combination of occlusion, roughness, and metalness images (PNG, JPEG, WebP, TIFF or TGA). Select the numeric source channel for each; grayscale files work with any RGB channel. For a gloss/smoothness source, enable inversion.
3. Select **Build preview** and inspect the three channel previews. Changing an input clears the previous preview.
4. Select **Apply map** to replace this layer's ORM map as one undoable edit. Cancel leaves the terrain unchanged, including during material preparation.

Empty output channels are white. They preserve slider control for roughness/metalness and contribute no occlusion. By default, supplied roughness and metalness maps set their corresponding sliders to 1; deselect **Use supplied…at full strength** to retain the current multipliers. A slider without a supplied map is unchanged. Albedo, normals, layer tint, placement rules, and other layers are preserved.

The composer accepts non-interlaced PNGs, including grayscale, indexed, RGB, and RGBA data, plus the [TIFF/TGA formats described above](#tiff-and-tga-texture-formats) and browser-decoded JPEG/WebP. PNG/TIFF/TGA numeric decoding avoids display gamma conversion; declared premultiplied alpha is handled as described above. Choose Alpha explicitly to use opacity. RGB luminance is a weighted combination of the stored RGB samples. Sixteen-bit PNG/TIFF channels remain normalized float samples during bilinear resizing; the final ORM is an opaque 8-bit PNG. Source files can have different dimensions, but should depict the same surface region and orientation. Output is embedded in the project; the separate source files are not retained as an editable recipe.

Preview calculation runs on a cancellable worker. Bad files, failed material preparation and history-capture failure leave the project and undo history unchanged; correct the input or retry Apply in the same panel.

## Reuse a surface in another landscape

Select a layer and use **Save surface** to download a `.surface.json` preset. It contains that layer's name, tint, physical settings, normal convention, embedded maps, and placement rules. Procedural fallback variants are retained, so a surface also keeps its appearance when loaded into a different layer slot without imported maps.

Select the destination layer and choose **Load surface**. By default, its altitude/slope ranges and feathering remain unchanged. Enable **Load saved placement rules** before loading to replace those values too. The destination layer ID, paint channel, and foliage-brush references always remain intact. Existing foliage instances are not repopulated; subsequent painting/population uses the resulting material weights.

Loading replaces the complete shading state, including removing destination maps that the preset does not contain. It does not change other layers, terrain heights, holes, props, lighting, or the project's texture resolution. Images and any changed placement-rule geometry are prepared before one undoable replacement. Invalid presets, failed image decoding or terrain/picking preparation, history-capture failure, cancellation, and requests superseded by editing or selecting another layer leave the current surface unchanged.

Presets embed only the selected surface's maps, with a separate 128 MiB JSON file limit. Very large materials can therefore fit in a native `.terrain` project while exceeding the portable preset limit; the error leaves the project unchanged. Model assets, terrain buffers, and the project-wide texture resolution are excluded. File reading and image preparation are cancellable; JSON parsing and serialization are synchronous, so very large presets can briefly block the editor.

## Placement and blending

Set altitude ranges in metres and slope ranges in degrees, then adjust feathering for gradual rule transitions. Paint overrides where automatic rules need art direction. Height blending changes how overlapping layers meet; it does not make a layer with zero coverage appear. Foliage brushes can restrict placement to these material weights.

Check the result under authored sun and environment lighting. Smooth shading supports continuous slopes; flat shading and lower grid resolutions support faceted terrain. Native projects and the embedded GLB authoring state preserve the maps, conventions, rules, and scalar settings. The PBR export option bakes standard color, ORM, and normal atlases for ordinary GLB viewers; Fast colors keeps the small vertex-color presentation. The toolkit runtime restores the original layered shader. See [scene export](EXPORT.md) for sampling and memory limits.

## Core API

The composer uses public, renderer-independent utilities:

```ts
import { decodeHeightmapPNG, packOrmMap, encodeRgbaPNG } from 'terrain-tools';

// Source bytes are ArrayBuffers. Pass false to avoid multiplying by opacity.
const occlusion = await decodeHeightmapPNG(aoBytes, false, 'red');
const roughness = await decodeHeightmapPNG(glossBytes, false, 'green');
const pixels = packOrmMap(
  { occlusion, roughness, roughnessIsGloss: true },
  1024,
);
const packedPng = await encodeRgbaPNG(1024, 1024, pixels);
```

Channel selection accepts red, green, blue, alpha, or luminance. Existing two-argument PNG decoding retains its luminance behavior. Packing accepts normalized float maps and output dimensions from 1 to 2048; inputs are not modified. These functions are asynchronous only where PNG compression/decompression requires it; hosts should use a worker for large compositions.

Surface presets also have public core functions:

```ts
import {
  serializeMaterialPreset,
  parseMaterialPreset,
  applyMaterialPreset,
  assertProjectCapacity,
} from 'terrain-tools';

const text = serializeMaterialPreset(project, project.materials[1].id);
const preset = parseMaterialPreset(text);
const replacement = applyMaterialPreset(project.materials[0], preset, {
  applyPlacementRules: false,
});
const candidate = {
  ...project,
  materials: project.materials.map((layer, i) =>
    i === 0 ? replacement : layer,
  ),
};
assertProjectCapacity(candidate);
await terrain.load(candidate); // Prepare images before replacing the runtime scene.
```

Parsing validates the material schema and embedded image references; the rendering host validates image decoding. Applying returns a new material and texture-map object without modifying the preset or destination. The core functions do not add history, alter a live scene, or write files. `proceduralVariant` is optional on ordinary layers; its absence retains the original slot-based fallback behavior.
