# Photoreal default foliage

Fresh editor projects include pine trees, ferns, meadow grass and flowering sorrel from the downloaded Poly Haven collection. Existing documents keep their own brushes; use **Foliage → Default brushes → Add default brush** to add a preset. Failed or cancelled preparation leaves the scene, history and autosave intact. A successful addition is one undo step. If startup asset loading fails, the editor opens procedural brushes and offers the same import controls for retry.

| Brush            | Source variants           | Scale range | Spacing | Detail distances / culling |
| ---------------- | ------------------------- | ----------- | ------- | -------------------------- |
| Pine trees       | Pine Tree 01 B            | 0.75–1.1    | 8 m     | 55 m, 130 m / 700 m        |
| Ferns            | Fern 02 B, A              | 0.85–1.3    | 0.75 m  | 22 m / 100 m               |
| Meadow grass     | Grass Medium 01 tall A, B | 1.4–2.5     | 0.22 m  | 12 m / 65 m                |
| Flowering sorrel | Shrub Sorrel 01 B, D      | 2–3.5       | 0.15 m  | 12 m / 65 m                |

Scale multiplies the source model's dimensions in metres. Trees stay upright; ground cover follows terrain slope. White tint retains the photographed albedo. Height masks keep bases rigid while the upper plants respond to wind. Pine contact crushing is disabled. Ground-cover distant LODs retain 70% of instances; tree LODs retain all instances. Transitions use 12% hysteresis and a 0.35-second fade. These are editable starting values, not a universal density or performance target.

Zoom in with the mouse wheel to inspect painted ground cover. The small plants are life-sized and disappear beyond their culling distances; the initial view framing the complete landscape is intended for trees and terrain.

## Prepared files and credits

The [prepared GLBs](../public/foliage/photoreal/) contain 15 models, about 21.6 MB in total. Each file embeds its geometry and PBR images, author credit, source URL, CC0 license reference and modification notes. [The generated manifest](../public/foliage/photoreal/manifest.json) records per-model triangle counts, sizes and hashes. The editor checks file size and SHA-256 before preparing it. Models are embedded when added, so native projects and saved brush presets are portable without the source asset directory.

| Source                                                     | Creator credit                                   | Prepared triangles, near → lower levels |
| ---------------------------------------------------------- | ------------------------------------------------ | --------------------------------------- |
| [Fern 02](https://polyhaven.com/a/fern_02)                 | Rico Cilliers: modeling; Rob Tuytel: scanning    | B: 2,384 → 1,072; A: 784 → 351          |
| [Shrub Sorrel 01](https://polyhaven.com/a/shrub_sorrel_01) | Rico Cilliers: author                            | B: 414 → 186; D: 990 → 445              |
| [Grass Medium 01](https://polyhaven.com/a/grass_medium_01) | Rico Cilliers: modeling; Rob Tuytel: photography | Tall A: 290 → 130; tall B: 310 → 139    |
| [Pine Tree 01](https://polyhaven.com/a/pine_tree_01)       | Rico Cilliers: modeling; Rob Tuytel: photography | B: 25,630 → 10,942 → 4,774              |

All sources are [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), under [Poly Haven's asset license](https://polyhaven.com/license). Full acknowledgments are in [the source credits](../assets/cc0-foliage/CREDITS.md) and the served [asset credits](../public/foliage/photoreal/CREDITS.txt).

## Rebuild

First obtain the optional original source collection using the [download and extraction instructions](../assets/cc0-foliage/README.md). The original ZIPs and extracted models are excluded from Git; the prepared GLBs and alpha masks are tracked. Running the editor and ordinary builds do not require this rebuild step.

```sh
npm ci
npm run build:assets:foliage
npm test -- tests/default-foliage.test.ts
npm run build
npm run test:browser -- tests/browser/photoreal-foliage.spec.mjs
```

The offline builder requires the original glTF/bin/JPEG files in `assets/cc0-foliage/poly-haven/<asset>/gltf-2k/`, plus the original PNG alpha masks in `assets/cc0-foliage/alpha-maps/`. [The alpha manifest](../assets/cc0-foliage/alpha-maps/manifest.json) pins official download URLs and checksums; these masks were missing from the downloaded glTF packages and were fetched separately. Regular builds use the prepared GLBs and do not process the large source pine.

The builder uses meshoptimizer 1.1.0 for geometry simplification and sharp 0.34.5 for texture preparation. It removes the source display-layout offsets, preserves metre units, grounds each variant and keeps the same pivot across its detail levels. Near textures fit inside 1024 × 1024; distant levels fit inside 512 × 512, maintaining aspect ratio. Original alpha is merged into PNG albedo, with double-sided alpha testing. Normal and packed material maps remain embedded; source bark texture transforms are retained.

The original pine B has over four million triangles. Ordinary reduction loses its needle coverage, so the prepared version keeps a simplified source trunk and branches and replaces tiny needle components with the author's photographed twig on cutout cards sampled across the original canopy. Near cards cross two planes; middle cards use one plane at the same positions; far cards use fewer, larger cutouts. This is an approximate real-time derivative, with visible differences at close range, not the original scanned geometry. Original archives and extracted sources are unmodified.

The synchronous SDK `createProject()` continues to provide procedural brushes without browser fetches. The editor adds the photographic collection during fresh-project startup. Saved documents already contain their chosen models; loading a document never silently substitutes these defaults.

## Validation limits

Local Chrome/WebGL checks cover all four plant types, pine distance levels, initial defaults, real painting, portable brush credits, undo/redo, autosave reload with bundled downloads blocked, and failed/cancelled additions followed by retry. Source and prepared-file checks verify references, hashes, embedded textures, credits, pivot bounds and decreasing LOD counts. This is not a frame-time certification for dense photoreal scenes, other browsers or mobile devices. Inspect close-up cutouts, transition distances and shadow quality for the intended scene and hardware.
