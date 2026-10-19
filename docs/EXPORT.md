# Scene export

The **GLB surface export** selector beside **Export scene** offers two presentations. Both files retain terrain holes, static props, the complete primary foliage population, water, and the embedded editable project.

- **Fast colors** retains the compact vertex-color presentation. It does not carry the terrain's layered PBR maps into an ordinary GLB viewer.
- **PBR · 1024² / 2048² / 4096²** bakes the terrain surface into standard base-color, occlusion/roughness/metalness, and normal textures. Ordinary glTF viewers and engines can use these without the toolkit shader.

The editor locks document editing while export runs and displays the current stage. **Cancel export** or Escape cancels the download without adding history or changing the project. GPU readback and image encoding already in progress finish before cleanup; cancellation is checked between stages.

## What the PBR bake preserves

The baker evaluates the same triplanar maps, layer tints, altitude/slope-derived vertex weights, paint overrides, height blending, optional texture-repetition reduction, normal strength, and OpenGL/DirectX source conventions used by the live terrain. Base color is encoded as sRGB; ORM and tangent-space normals remain numeric. Lighting, fog, exposure, shadows, and reflections are not baked into the base color. Set up lighting in the destination application.

Every terrain chunk shares one XZ atlas. Exported UVs and tangents define a consistent normal-map frame. Flat terrain exports carry explicit face normals. Terrain holes remain absent from the exported geometry; the bake samples through hole regions only to avoid blank texels bleeding into their rims.

Foliage and props retain their standard source materials. Foliage exports use complete primary meshes, independent of the current LOD/culling state. Wind and contact animation require the toolkit runtime or equivalent destination shaders; standard GLB presentation is static. The terrain height map affects layer blending, not geometric displacement.

## Choose a resolution

This is a fixed-resolution atlas for the entire terrain, not a new texture array per layer. A 192 m landscape at 2048² has roughly 9.4 cm per texel in XZ. Steep slopes spread that coverage over more surface area. Fine repeated detail, sharp paint boundaries, and normal transitions can lose detail during baking and filtering.

| Atlas | Raw pixels for three RGBA maps |
| ----- | ------------------------------ |
| 1024² | 12 MiB                         |
| 2048² | 48 MiB                         |
| 4096² | 192 MiB                        |

These figures exclude the source maps, GPU target/readback buffers, geometry copies, PNG encoding, and the editable project. Compressed file size depends on image content. Use a smaller atlas on memory-constrained devices. The runtime API also accepts 256² and 512² for previews. GPU limits and context loss produce errors; source resources are retained and temporary bake resources are released.

PBR maps are 8-bit PNGs. They approximate the layered shader at the selected sampling density. A deterministic browser fixture with a sloped 32 m heightfield, two blended texture sets, and a central hole compares the standard GLB loader with the live shader under the same lights. With repetition reduction on both active layers, a 1024² bake and 256² render differ by at most three 8-bit channel levels for smooth and flat shading ([recorded comparison](benchmarks/pbr-export-variation-2026-10-15.json)). This is a regression fixture, not a universal visual-quality guarantee.

## Runtime API

```ts
import { exportTerrainGLB, bakeTerrainSurface } from 'terrain-tools/three';

const glb = await exportTerrainGLB(terrain, {
  surface: 'pbr',
  renderer,
  resolution: 2048,
  signal: controller.signal,
  onProgress: (message) => showStatus(message),
});

// For a host that needs the baked maps separately:
const surface = await bakeTerrainSurface(terrain, {
  renderer,
  resolution: 1024,
});
console.log(surface.material.map, surface.material.normalMap);
// The host owns the returned material and its maps:
surface.dispose();
```

Standalone maps use `u = x / size + 0.5` and `v = 0.5 - z / size`. Their normals expect the matching per-vertex tangent `normalize([normal.y, -normal.x, 0])`, handedness +1, and the same smooth or flat geometry normals used during baking. GLB export writes these attributes automatically.

The renderer is required for PBR export. Omitting options preserves the fast-color export behavior. Keep the source project, scene, and borrowed model resources alive and unchanged until the export promise settles. The renderer can continue drawing between bake passes; its render target, clear settings, XR setting, and shadow enable state are restored. Do not run concurrent bakes or raw pixel-buffer operations on the same renderer.

Baking uses asynchronous GPU readback. Serialization, geometry preparation, image encoding, and project packaging still require temporary memory and some main-thread work. An aborted export rejects with `AbortError`; it does not return a partial file.

`loadTerrain(glb)` reads the embedded project and rebuilds the original layered surface and procedural behavior, retaining source-map resolution independently of the static atlas. Reopening the GLB in the editor restores the same authoring data. See [runtime integration](RUNTIME.md) and [project files](PROJECT-FILES.md).
