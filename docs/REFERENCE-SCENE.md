# Upland meadow reference scene

Open **Sculpt → Reference landscape → Open upland meadow** in the editor. Loading is cancellable and creates one undo step. Or visit `/runtime.html?sample=upland`, choose Trail / Overview / Grass detail, and download the editable scene.

The checked-in package is `public/examples/upland/upland-meadow.terrain`. It embeds every required image and model: opening the downloaded file needs no external asset requests.

## What to try

- In **Surfaces**, compare **Reduce texture repetition** on Dry meadow or Limestone faces at close and distant views. It is off in the supplied scene. Adjust Dry meadow’s slope ceiling or Summit scree’s altitude. The footpath is painted into Worn footpath; its automatic altitude interval lies below this scene.
- In **Foliage**, inspect the two weighted models, independent scale ranges, material restriction, spacing, flexibility ramp, and lower-detail mesh. Paint more grass, or Populate using the existing seed. Population honors surface rules; the sample’s clearings around rocks are authored removals and will be repopulated.
- In **World**, change wind direction, strength, gusts, and recovery. In the runtime’s Grass detail view, Contact pulse compresses plants near the view target and lets them recover.
- Select limestone props, move them, or enable a cutout. The shipped scene has no holes; use Cut hole to inspect the matching visual/collision opening.
- Export with PBR selected to compare the standard static GLB presentation. Save the native project to retain layered authoring, wind, and recovery.

## Assets and reproduction

This 96 m square, 128-cell scene contains 5,263 plants, 34 rock props, four surface layers, and four embedded static GLBs. The native file is about 19.8 MiB. Near grass uses 192 or 128 triangles; its shared lower-detail model uses 32. Source PNGs are 1254²; terrain arrays sample them at 1024².

The three PNGs were generated with the built-in image generation tool, then copied unchanged into `public/examples/upland/`. They are original generated color/opacity artwork, **not photographs, scans, measured reflectance, or validated botanical data**. [The prompt record](reference-asset-prompts.json) includes the grass cleanup edit. Geometry, terrain, placement, and lighting are deterministic code in [the builder](../scripts/build-upland-example.mjs). No external asset download is needed.

After installing dependencies:

```sh
npm run build:runtime
npm run build:example:upland
npm run build
```

The builder writes four GLBs, the native package, and a manifest with counts, camera viewpoints, dimensions, and SHA-256 hashes. Source PNGs are never rewritten. The manifest lets reviewers detect asset or generated-scene changes.

## Visual and performance limits

This is an editable art/workflow example, not proof of AA production readiness or simulation accuracy. Base-color tiling can repeat; the source textures have not been certified seamless. Procedural fallback normal, ORM, and height detail accompanies the generated color maps; these channels were not measured from the depicted surfaces. Grass uses crossed alpha-tested cards with upward-biased normals and does not model leaf transmission. Large close-ups expose those approximations.

The sample uses a procedural sky, sun, and authored exposure, without a photographic HDRI. Lower-detail density changes, alpha cutouts, shadow resolution, texture arrays, and a roughly 20 MiB embedded document still require representative device/GPU budget checks. Physical pen/touch and cross-browser validation remain separate work.
